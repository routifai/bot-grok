// `files.*` for the Computer panel's Files tab: browse the Muse's Conversation workspace on the
// engine (engine session filesystem routes), preview one file, or save one to the Library.

import { createHash } from "node:crypto";
import {
  confineWorkspacePath,
  createOmnigentArtifact,
  findOmnigentKnowledge,
  ingestOmnigentKnowledge,
  listOmnigentFiles,
  looksBinary,
  OmnigentApiError,
  type OmnigentClientConfig,
  type OmnigentFileEntry,
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
  isIngestableAttachmentMimeType,
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

/** The engine answered with this error code (`OmnigentApiError.code`, from the error body). */
function hasEngineCode(error: unknown, ...codes: string[]): boolean {
  return (
    error instanceof OmnigentApiError && error.code !== undefined && codes.includes(error.code)
  );
}

/** The Computer's runner is still (re)connecting; the panel shows "starting" and retries. */
function isComputerStarting(error: unknown): boolean {
  return hasEngineCode(error, "runner_unavailable", "runner_capability_mismatch");
}

/** Confinement errors are the caller's mistake; engine "not found" stays a 404. */
function mapError(error: unknown): never {
  if (error instanceof WorkspacePathError) {
    throw new ORPCError("BAD_REQUEST", { message: error.message });
  }
  if (hasEngineCode(error, "not_found")) {
    throw new ORPCError("NOT_FOUND", { message: "File not found" });
  }
  if (isComputerStarting(error)) {
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

async function listOrEmpty(
  client: OmnigentClientConfig,
  email: string,
  sessionId: string,
  dir: string,
): Promise<OmnigentFileEntry[]> {
  // A folder that does not exist yet (404) simply has nothing in it.
  return listOmnigentFiles(client, email, sessionId, dir).catch((error: unknown) => {
    if (hasEngineCode(error, "not_found")) return [];
    throw error;
  });
}

/** How many times an upload picks a name again when another upload took it first. */
const UPLOAD_NAME_ATTEMPTS = 5;

/** Whether `name` is `base` or one of its numbered copies (`base (2).ext`). */
export function isCopyOf(name: string, base: string): boolean {
  const stemAndExt = (value: string): [string, string] => {
    const dot = value.lastIndexOf(".");
    return dot > 0 ? [value.slice(0, dot), value.slice(dot).toLowerCase()] : [value, ""];
  };
  const [stem, ext] = stemAndExt(base);
  const [candidateStem, candidateExt] = stemAndExt(name);
  return ext === candidateExt && candidateStem.replace(/ \(\d+\)$/, "") === stem;
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
    const chosen = safeUploadName(input.name, input.mimeType);
    // The same file attached again reuses the stored copy and its index entry. Only a file the
    // Computer indexes is looked up (an image never is), and only a copy that carries the name the
    // person chose is reused, so the name they see is the name they picked.
    if (isIngestableAttachmentMimeType(input.mimeType)) {
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const duplicate = await findOmnigentKnowledge(client, email, sessionId, { sha256 });
      if (duplicate.found && duplicate.path && duplicate.name && isCopyOf(duplicate.name, chosen)) {
        return {
          path: duplicate.path,
          name: duplicate.name,
          mimeType: input.mimeType,
          size: bytes.byteLength,
        };
      }
    }
    // The name is picked from the folder and written with an exclusive create: two uploads that
    // chose the same free name cannot overwrite each other, the loser picks the next number.
    for (let attempt = 0; attempt < UPLOAD_NAME_ATTEMPTS; attempt += 1) {
      const existing = await listOrEmpty(client, email, sessionId, dir);
      const name = dedupeUploadName(chosen, new Set(existing.map((entry) => entry.name)));
      const path = `${dir}/${name}`;
      try {
        await writeOmnigentFile(client, email, sessionId, path, bytes, { exclusive: true });
      } catch (error) {
        if (hasEngineCode(error, "already_exists")) continue;
        throw error;
      }
      return { path, name, mimeType: input.mimeType, size: bytes.byteLength };
    }
    throw new ORPCError("CONFLICT", { message: "Could not pick a free name for this file" });
  } catch (error) {
    if (isComputerStarting(error)) {
      throw new ORPCError("SERVICE_UNAVAILABLE", {
        message: "Your Computer is starting. Try again in a moment.",
      });
    }
    return mapError(error);
  }
}

/** Reads an uploaded attachment in the Computer and answers when it is searchable. One awaited
 * call: the composer keeps Send disabled until it returns. Wakes the Computer. */
export async function engineIngestAttachment(
  deps: EngineFilesDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  input: { botId: string; path: string },
): Promise<{ fileId: string; name: string; pages: number; chars: number }> {
  const bot = await deps.prisma.bot.findFirst({
    where: { id: input.botId, spaceId: actor.spaceId, userId: actor.userId },
    select: { id: true },
  });
  if (!bot) throw new ORPCError("NOT_FOUND", { message: "Muse not found" });
  let path: string;
  try {
    path = confineWorkspacePath(input.path);
  } catch (error) {
    return mapError(error);
  }
  if (path !== input.path || !path.startsWith(WORKSPACE_UPLOADS_PREFIX)) {
    throw new ORPCError("BAD_REQUEST", { message: "Attachment is not an uploaded file" });
  }
  try {
    const { email, sessionId } = await resolveMuseSession(deps, client, actor);
    const read = await ingestOmnigentKnowledge(client, email, sessionId, { path });
    return { fileId: read.file_id, name: read.name, pages: read.pages, chars: read.chars };
  } catch (error) {
    if (isComputerStarting(error)) {
      throw new ORPCError("SERVICE_UNAVAILABLE", {
        message: "Your Computer is starting. Try again in a moment.",
      });
    }
    // The Computer is awake but the read did not finish in time: its own message, never "starting".
    if (hasEngineCode(error, "knowledge_timeout")) {
      throw new ORPCError("GATEWAY_TIMEOUT", {
        message: "Reading this file is taking too long. Try again in a moment.",
      });
    }
    if (hasEngineCode(error, "invalid_input", "not_found")) {
      throw new ORPCError("BAD_REQUEST", { message: "Nova couldn't read this file." });
    }
    return mapError(error);
  }
}
