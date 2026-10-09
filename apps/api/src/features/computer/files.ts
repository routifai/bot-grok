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
  writeOmnigentFile,
} from "@nova/adapters";
import type { Actor, Artifact } from "@nova/contracts";
import {
  AttachmentValidationError,
  attachmentExtensionForMimeType,
  decodeAttachmentBase64,
  validateAttachmentMimeType,
  WORKSPACE_UPLOADS_PREFIX,
} from "@nova/core";
import type { PrismaClient } from "@nova/db";
import { ORPCError } from "@orpc/server";
import { resolveMuseSession } from "./muse-session.js";

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

/** A file name that is safe as one path segment: no separators or control characters, no leading
 * dots, bounded length; an extension is added from the mime type when the name has none. */
export function safeUploadName(name: string, mimeType: string): string {
  const base = (name.split(/[\\/]/).pop() ?? "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/^\.+/, "")
    .trim();
  let result = base || "file";
  if (result.length > 120) {
    const dot = result.lastIndexOf(".");
    const ext = dot > 0 && result.length - dot <= 12 ? result.slice(dot) : "";
    result = result.slice(0, 120 - ext.length) + ext;
  }
  if (!/\.[A-Za-z0-9]{1,12}$/.test(result)) result += attachmentExtensionForMimeType(mimeType);
  return result;
}

/** `name.ext` -> `name (2).ext`, `name (3).ext`, ... until it is not in `taken`. */
export function dedupeUploadName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 2; ; n += 1) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Writes a composer attachment into the Muse's workspace under
 * `your_files/uploads/<date>/` and returns where it landed. Wakes the Computer. */
export async function engineUploadAttachment(
  deps: EngineFilesDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  input: { botId: string; name: string; mimeType: string; contentBase64: string },
  now: Date = new Date(),
): Promise<{ path: string; name: string; mimeType: string; size: number }> {
  const bot = await deps.prisma.bot.findFirst({
    where: { id: input.botId, spaceId: actor.spaceId, userId: actor.userId },
    select: { id: true },
  });
  if (!bot) throw new ORPCError("NOT_FOUND", { message: "Muse not found" });
  let bytes: Uint8Array;
  try {
    validateAttachmentMimeType(input.mimeType);
    bytes = decodeAttachmentBase64(input.contentBase64);
  } catch (error) {
    if (error instanceof AttachmentValidationError) {
      throw new ORPCError("BAD_REQUEST", { message: error.message });
    }
    throw error;
  }
  const { email, sessionId } = await resolveMuseSession(deps, client, actor);
  const dir = `${WORKSPACE_UPLOADS_PREFIX}${now.toISOString().slice(0, 10)}`;
  try {
    // A folder that does not exist yet (404) simply has nothing to collide with.
    const existing = await listOmnigentFiles(client, email, sessionId, dir).catch(
      (error: unknown) => {
        if (error instanceof Error && /\(404\)/.test(error.message)) return [];
        throw error;
      },
    );
    const name = dedupeUploadName(
      safeUploadName(input.name, input.mimeType),
      new Set(existing.map((entry) => entry.name)),
    );
    const path = `${dir}/${name}`;
    await writeOmnigentFile(client, email, sessionId, path, bytes);
    return { path, name, mimeType: input.mimeType, size: bytes.byteLength };
  } catch (error) {
    if (error instanceof Error && /\(503\)/.test(error.message)) {
      throw new ORPCError("SERVICE_UNAVAILABLE", {
        message: "Your Computer is starting. Try again in a moment.",
      });
    }
    return mapError(error);
  }
}
