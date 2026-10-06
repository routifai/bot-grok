// The Project a session is working in (docs/adr/0008): a session whose working directory is
// `~/workspace/projects/<slug>` has that Project open. The engine only stores the directory;
// the name comes from the folder's `PROJECT.md` card.
import { getOmnigentSession } from "./client/sessions.js";
import type { OmnigentClientConfig } from "./client.js";
import { readOmnigentFile } from "./files.js";

export interface WorkingProject {
  slug: string;
  /** The card's `name`, or the slug when the card cannot be read. */
  name: string;
}

const PROJECT_DIR = /\/workspace\/projects\/([a-z0-9][a-z0-9_-]{0,63})(?:\/|$)/;
const FRONT_MATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** The Project slug a working directory is in (or under), or null at the workspace root. */
export function projectSlugFromWorkspace(workspace: string | null | undefined): string | null {
  return workspace?.match(PROJECT_DIR)?.[1] ?? null;
}

/** The `name` in a `PROJECT.md` card's front matter, or null. */
export function projectNameFromCard(text: string): string | null {
  const block = text.match(FRONT_MATTER)?.[1];
  const line = block?.match(/^name:[ \t]*(.+?)[ \t]*$/m)?.[1];
  const name = line?.replace(/^(["'])(.*)\1$/, "$2").trim();
  return name || null;
}

/** The Project the session has open, or null. Reads one session row and, when a Project is
 * open, the first bytes of its card. */
export async function getOmnigentWorkingProject(
  config: OmnigentClientConfig,
  email: string,
  sessionId: string,
): Promise<WorkingProject | null> {
  const session = await getOmnigentSession(config, email, sessionId);
  const slug = projectSlugFromWorkspace(session.workspace);
  if (!slug) return null;
  try {
    const card = await readOmnigentFile(config, email, sessionId, `projects/${slug}/PROJECT.md`);
    const name = projectNameFromCard(new TextDecoder().decode(card.bytes.slice(0, 4096)));
    return { slug, name: name ?? slug };
  } catch {
    return { slug, name: slug };
  }
}
