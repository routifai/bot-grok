// The Project a session is working in (docs/adr/0008): the engine reports it on the session's
// Super Chat block (`superchat.project`, ADR 0009), name included.
import { getOmnigentSession } from "./client/sessions.js";
import type { OmnigentClientConfig } from "./client.js";

export interface WorkingProject {
  slug: string;
  name: string;
}

/** The Project the session has open, or null. One session read. */
export async function getOmnigentWorkingProject(
  config: OmnigentClientConfig,
  email: string,
  sessionId: string,
): Promise<WorkingProject | null> {
  const session = await getOmnigentSession(config, email, sessionId);
  return session.superchat?.project ?? null;
}
