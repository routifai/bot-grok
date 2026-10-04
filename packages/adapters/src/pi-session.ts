import { rm } from "node:fs/promises";
import path from "node:path";

// Transcripts the retired Pi runtime may have recorded under DATA_DIR (opt-in, so most
// installs have none). Nothing writes them any more; deleting a Muse still removes them.

function sessionScopeSegment(value: string, label: string): string {
  if (!value) throw new Error(`${label} must be non-empty`);
  return Buffer.from(value, "utf8").toString("base64url");
}

export function piSessionBotRoot(sessionsRoot: string, userId: string, botId: string): string {
  return path.join(
    path.resolve(sessionsRoot),
    sessionScopeSegment(userId, "userId"),
    sessionScopeSegment(botId, "botId"),
  );
}

export function piSessionsRoot(dataDir: string): string {
  return path.resolve(dataDir, "pi-sessions");
}

export async function removePiBotSessions(
  dataDir: string | undefined,
  userId: string | undefined,
  botId: string,
): Promise<void> {
  if (!dataDir) return;
  if (!userId) throw new Error("userId is required to remove Pi bot sessions");
  await rm(piSessionBotRoot(piSessionsRoot(dataDir), userId, botId), {
    recursive: true,
    force: true,
  });
}
