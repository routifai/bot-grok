// `ideas.*` for Muses whose proactive work the engine owns
// (docs/adr/0005-proactive-work-is-scheduled-helper-runs.md). An Idea is an engine suggestion
// recorded by the standing Study run under the Muse's Super Chat; "Do it" marks it done and
// sends its message into the Conversation, "Dismiss" marks it dismissed. Nova keeps no Idea
// rows for these Muses.
import {
  listOmnigentSuggestions,
  type OmnigentClientConfig,
  type OmnigentSuggestion,
  patchOmnigentSuggestion,
} from "@aiden/adapters";
import type { Actor, Idea } from "@aiden/contracts";
import type { PrismaClient } from "@aiden/db";
import { ORPCError } from "@orpc/server";

/** Grouping label every engine Idea carries (the UI shows one plain list). */
export const ENGINE_IDEA_AREA = "suggested";

export interface EngineIdeasDeps {
  prisma: PrismaClient;
  /** Sends `text` into the person's Conversation as their own message (the same path as a
   * typed follow-up) and starts the turn. */
  sendMessage: (actor: Actor, botId: string, text: string) => Promise<void>;
}

interface Target {
  email: string;
  sessionId: string;
}

async function resolve(deps: EngineIdeasDeps, actor: Actor, botId: string): Promise<Target | null> {
  const [bot, user, session] = await Promise.all([
    deps.prisma.bot.findFirst({
      where: { id: botId, spaceId: actor.spaceId, userId: actor.userId },
      select: { id: true },
    }),
    deps.prisma.user.findUnique({ where: { id: actor.userId }, select: { email: true } }),
    deps.prisma.omnigentSession.findUnique({
      where: { botId },
      select: { omnigentSessionId: true },
    }),
  ]);
  if (!bot || !user) throw new ORPCError("NOT_FOUND", { message: "Muse not found" });
  return session ? { email: user.email, sessionId: session.omnigentSessionId } : null;
}

const toIdea = (item: OmnigentSuggestion): Idea => ({
  id: item.id,
  text: item.title,
  area: ENGINE_IDEA_AREA,
  detail: item.why,
  createdAt: new Date(item.created_at * 1000).toISOString(),
});

export async function engineListIdeas(
  deps: EngineIdeasDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  botId: string,
): Promise<Idea[]> {
  const target = await resolve(deps, actor, botId);
  if (!target) return [];
  return (await listOmnigentSuggestions(client, target.email, target.sessionId)).map(toIdea);
}

/** The open suggestion `ideaId` of this Muse's Conversation, or a not-found error. */
async function openIdea(
  client: OmnigentClientConfig,
  target: Target,
  ideaId: string,
): Promise<OmnigentSuggestion> {
  const found = (await listOmnigentSuggestions(client, target.email, target.sessionId)).find(
    (item) => item.id === ideaId,
  );
  if (!found) throw new ORPCError("NOT_FOUND", { message: "Idea not found" });
  return found;
}

/** "Do it": mark the Idea done, then send its message into the Conversation. */
export async function engineAcceptIdea(
  deps: EngineIdeasDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  input: { botId: string; ideaId: string },
): Promise<{ ok: true }> {
  const target = await resolve(deps, actor, input.botId);
  if (!target) throw new ORPCError("NOT_FOUND", { message: "This Muse has no Conversation yet" });
  const idea = await openIdea(client, target, input.ideaId);
  await patchOmnigentSuggestion(client, target.email, idea.id, "done");
  try {
    await deps.sendMessage(actor, input.botId, idea.message);
  } catch (error) {
    // Not sent: give the Idea back so the person can try again.
    await patchOmnigentSuggestion(client, target.email, idea.id, "open").catch(() => undefined);
    throw error;
  }
  return { ok: true as const };
}

export async function engineDismissIdea(
  deps: EngineIdeasDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  input: { botId: string; ideaId: string },
): Promise<{ ok: true }> {
  const target = await resolve(deps, actor, input.botId);
  if (!target) throw new ORPCError("NOT_FOUND", { message: "This Muse has no Conversation yet" });
  const idea = await openIdea(client, target, input.ideaId);
  await patchOmnigentSuggestion(client, target.email, idea.id, "dismissed");
  return { ok: true as const };
}
