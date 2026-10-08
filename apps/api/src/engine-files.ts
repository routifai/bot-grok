// `files.*` for the Computer panel's Files tab: browse the Muse's Conversation workspace on the
// engine (engine session filesystem routes), preview one file, or save one to the Library.
import {
  confineWorkspacePath,
  createOmnigentArtifact,
  listOmnigentFiles,
  looksBinary,
  type OmnigentClientConfig,
  readOmnigentFile,
  WORKSPACE_FILE_MAX_BYTES,
  WorkspacePathError,
  workspaceMimeType,
} from "@nova/adapters";
import type { Actor, Artifact } from "@nova/contracts";
import type { PrismaClient } from "@nova/db";
import { ORPCError } from "@orpc/server";

export interface EngineFilesDeps {
  prisma: PrismaClient;
}

async function target(
  deps: EngineFilesDeps,
  actor: Actor,
  botId: string,
): Promise<{ email: string; sessionId: string }> {
  const bot = await deps.prisma.bot.findFirst({
    where: { id: botId, spaceId: actor.spaceId, userId: actor.userId },
    select: { omnigentSession: { select: { omnigentSessionId: true } } },
  });
  if (!bot) throw new ORPCError("NOT_FOUND", { message: "Muse not found" });
  const sessionId = bot.omnigentSession?.omnigentSessionId;
  if (!sessionId) throw new ORPCError("NOT_FOUND", { message: "No workspace yet" });
  const user = await deps.prisma.user.findUnique({
    where: { id: actor.userId },
    select: { email: true },
  });
  if (!user) throw new ORPCError("UNAUTHORIZED");
  return { email: user.email, sessionId };
}

/** Confinement errors are the caller's mistake; engine "not found" stays a 404. */
function mapError(error: unknown): never {
  if (error instanceof WorkspacePathError) {
    throw new ORPCError("BAD_REQUEST", { message: error.message });
  }
  if (error instanceof Error && /\(404\)/.test(error.message)) {
    throw new ORPCError("NOT_FOUND", { message: "File not found" });
  }
  // The Computer's runner is still (re)connecting; the panel shows "starting" and retries.
  if (error instanceof Error && /\(503\)/.test(error.message)) {
    throw new ORPCError("SERVICE_UNAVAILABLE", { message: "Starting the Computer" });
  }
  throw error;
}

export async function engineListFiles(
  deps: EngineFilesDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  input: { botId: string; path: string },
) {
  const { email, sessionId } = await target(deps, actor, input.botId);
  const entries = await listOmnigentFiles(client, email, sessionId, input.path).catch(mapError);
  return { entries };
}

export async function engineReadFile(
  deps: EngineFilesDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  input: { botId: string; path: string },
) {
  const { email, sessionId } = await target(deps, actor, input.botId);
  const file = await readOmnigentFile(client, email, sessionId, input.path).catch(mapError);
  const name = confineWorkspacePath(input.path).split("/").pop() ?? input.path;
  const binary = looksBinary(file.bytes);
  const mimeType = workspaceMimeType(name, !binary);
  const tooLarge = file.size > WORKSPACE_FILE_MAX_BYTES || file.truncated;
  const previewable = !binary || mimeType !== "application/octet-stream";
  return {
    path: file.path,
    name,
    mimeType,
    size: file.size,
    tooLarge,
    binary,
    contentBase64: tooLarge || !previewable ? null : Buffer.from(file.bytes).toString("base64"),
  };
}

export async function engineSaveFileToLibrary(
  deps: EngineFilesDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  input: { botId: string; path: string },
): Promise<Artifact> {
  const { email, sessionId } = await target(deps, actor, input.botId);
  const file = await readOmnigentFile(client, email, sessionId, input.path).catch(mapError);
  if (file.truncated || file.size > WORKSPACE_FILE_MAX_BYTES) {
    throw new ORPCError("BAD_REQUEST", { message: "File is too large to save" });
  }
  const name = confineWorkspacePath(input.path).split("/").pop() ?? input.path;
  const item = await createOmnigentArtifact(client, email, {
    parentSessionId: sessionId,
    name,
    bytes: file.bytes,
  }).catch((error: unknown) => {
    if (error instanceof Error && /\(400\)|\(422\)/.test(error.message)) {
      throw new ORPCError("BAD_REQUEST", {
        message: "This file type can't be saved to the Library",
      });
    }
    throw error;
  });
  return {
    id: item.id,
    botId: input.botId,
    groupId: null,
    runId: null,
    name: item.name,
    description: item.title,
    mimeType: item.mime.split(";")[0]?.trim() || item.mime,
    size: item.size,
    version: item.version,
    createdAt: new Date(item.created_at * 1000).toISOString(),
  };
}
