// Real `activities.*` handlers (packages/contracts/src/rpc/activity.ts, docs/super-chat/WIRING.md
// slice A1): the Activity panel for a Muse's Super Chat family (the Conversation, its Side
// Chats, and their Helpers). Owner-of-the-bot only — unlike `chats.messages`/`chats.send`, there
// is no separate chatId ownership rule here, since the Activity Feed is always read from the
// Super Chat's own session id (Omnigent derives the whole family from it).
import {
  getOmnigentActivity,
  listOmnigentActivities,
  mapActivity,
  streamOmnigentActivityChanges,
} from "@nova/adapters";
import type { Activity, ActivityChanged, ActivityPage, Actor } from "@nova/contracts";
import { onSuperChat } from "../../omnigent-errors.js";
import { requireClient, requireSuperChat, type SuperChatDeps } from "../../super-chat-session.js";

export async function listActivities(
  deps: SuperChatDeps,
  actor: Actor,
  input: { botId: string; before?: number; limit?: number },
  env: NodeJS.ProcessEnv = process.env,
): Promise<ActivityPage> {
  const client = requireClient(env, actor);
  const { superSessionId, email, timezone } = await requireSuperChat(deps, actor, input.botId);
  const page = await onSuperChat(
    listOmnigentActivities(client, email, superSessionId, {
      before: input.before,
      limit: input.limit,
      tz: timezone,
    }),
  );
  return {
    activities: page.data.map((raw) => mapActivity(raw)),
    hasMore: Boolean(page.has_more),
  };
}

export async function getActivity(
  deps: SuperChatDeps,
  actor: Actor,
  input: { botId: string; activityId: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<Activity> {
  const client = requireClient(env, actor);
  const { superSessionId, email, timezone } = await requireSuperChat(deps, actor, input.botId);
  const activity = await onSuperChat(
    getOmnigentActivity(client, email, superSessionId, input.activityId, { tz: timezone }),
  );
  return mapActivity(activity);
}

/** `activities.watch`: tells the panel (and the chat's Helper rows) when to re-read the feed,
 * relayed from the engine's own session streams, so a Helper shows the moment it starts. The
 * stream ends when the engine's does; the web reconnects and re-reads. */
export async function* watchActivities(
  deps: SuperChatDeps,
  actor: Actor,
  input: { botId: string },
  signal: AbortSignal | undefined,
  env: NodeJS.ProcessEnv = process.env,
): AsyncGenerator<ActivityChanged> {
  const client = requireClient(env, actor);
  const { superSessionId, email } = await requireSuperChat(deps, actor, input.botId);
  try {
    for await (const frame of streamOmnigentActivityChanges(
      client,
      email,
      superSessionId,
      signal,
    )) {
      if (frame.type === "activities.changed") yield { type: "changed" };
      else if (frame.type === "session.heartbeat") yield { type: "heartbeat" };
    }
  } catch (error) {
    // A closed tab aborts the fetch; that is the normal end of a watch, not a failure.
    if (!signal?.aborted) throw error;
  }
}
