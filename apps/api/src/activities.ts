// Real `activities.*` handlers (packages/contracts/src/rpc.ts, docs/super-chat/WIRING.md slice
// A1): the Activity panel for a Muse's Super Chat family (the Conversation, its Side Chats,
// and their Helpers). Owner-of-the-bot only — unlike `chats.messages`/`chats.send`, there is no
// separate chatId ownership rule here, since the Activity Feed is always read from the Super
// Chat's own session id (Omnigent derives the whole family from it).
import {
  forgetOmnigentMemoryClaim,
  getOmnigentActivity,
  getOmnigentMemoryProfile,
  listOmnigentActivities,
  listOmnigentDailyNotes,
  listOmnigentMemoryClaims,
  mapActivity,
  type OmnigentClientConfig,
  type OmnigentDailyNote,
  type OmnigentMemoryClaim,
  omnigentClientConfigFromEnv,
  omnigentClientFor,
  patchOmnigentMemoryClaim,
  putOmnigentDailyNote,
  redactMemoryProfile,
  streamOmnigentActivityChanges,
} from "@aiden/adapters";
import type { Activity, ActivityChanged, ActivityPage, Actor } from "@aiden/contracts";
import type { PrismaClient } from "@aiden/db";
import { ORPCError } from "@orpc/server";
import { onSuperChat } from "./omnigent-errors.js";

export interface ActivitiesDeps {
  prisma: PrismaClient;
}

/** The engine client for the actor's space (the tenant every engine call carries). */
function requireClient(env: NodeJS.ProcessEnv, actor: Actor): OmnigentClientConfig {
  const connection = omnigentClientConfigFromEnv(env);
  if (!connection) {
    throw new ORPCError("BAD_REQUEST", { message: "Chat is not available right now." });
  }
  return omnigentClientFor(connection, actor.spaceId);
}

async function requireSuperChat(
  deps: ActivitiesDeps,
  actor: Actor,
  botId: string,
): Promise<{ superSessionId: string; email: string; timezone: string | undefined }> {
  const [bot, user] = await Promise.all([
    deps.prisma.bot.findFirst({
      where: { id: botId, spaceId: actor.spaceId, userId: actor.userId },
      select: { id: true },
    }),
    deps.prisma.user.findUnique({
      where: { id: actor.userId },
      select: { email: true, timezone: true },
    }),
  ]);
  if (!bot || !user) throw new ORPCError("NOT_FOUND", { message: "Muse not found" });
  const session = await deps.prisma.omnigentSession.findUnique({
    where: { botId },
    select: { omnigentSessionId: true },
  });
  if (!session) {
    throw new ORPCError("NOT_FOUND", { message: "This Muse has no Conversation yet" });
  }
  return {
    superSessionId: session.omnigentSessionId,
    email: user.email,
    timezone: user.timezone ?? undefined,
  };
}

export async function listActivities(
  deps: ActivitiesDeps,
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
  deps: ActivitiesDeps,
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
  deps: ActivitiesDeps,
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

/** `memory.profile`: the Muse's Memory Profile, read from the same Super Chat. */
export async function getMemoryProfile(
  deps: ActivitiesDeps,
  actor: Actor,
  input: { botId: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ profile: string | null }> {
  const client = requireClient(env, actor);
  const { superSessionId, email } = await requireSuperChat(deps, actor, input.botId);
  const result = await onSuperChat(getOmnigentMemoryProfile(client, email, superSessionId));
  return { profile: redactMemoryProfile(result.profile, client.secrets ?? []) };
}

function mapClaim(claim: OmnigentMemoryClaim, secrets: string[]) {
  return {
    id: claim.claim_id,
    kind: claim.kind,
    text: redactMemoryProfile(claim.text, secrets) ?? "",
    origin: claim.origin,
    personAuthored: claim.person_authored,
    date: claim.last_confirmed,
  };
}

/** `memory.claims`: the person's active memory claims, for the editable sections. */
export async function listMemoryClaims(
  deps: ActivitiesDeps,
  actor: Actor,
  input: { botId: string },
  env: NodeJS.ProcessEnv = process.env,
) {
  const client = requireClient(env, actor);
  const { superSessionId, email } = await requireSuperChat(deps, actor, input.botId);
  const claims = await onSuperChat(listOmnigentMemoryClaims(client, email, superSessionId));
  return { claims: claims.map((claim) => mapClaim(claim, client.secrets ?? [])) };
}

/** `memory.editClaim`: the person's text edit of one claim. */
export async function editMemoryClaim(
  deps: ActivitiesDeps,
  actor: Actor,
  input: { botId: string; claimId: string; text: string },
  env: NodeJS.ProcessEnv = process.env,
) {
  const client = requireClient(env, actor);
  const { superSessionId, email } = await requireSuperChat(deps, actor, input.botId);
  const claim = await onSuperChat(
    patchOmnigentMemoryClaim(client, email, superSessionId, input.claimId, input.text),
  );
  return mapClaim(claim, client.secrets ?? []);
}

/** `memory.forgetClaim`: the person deletes one claim. */
export async function forgetMemoryClaim(
  deps: ActivitiesDeps,
  actor: Actor,
  input: { botId: string; claimId: string },
  env: NodeJS.ProcessEnv = process.env,
) {
  const client = requireClient(env, actor);
  const { superSessionId, email } = await requireSuperChat(deps, actor, input.botId);
  await onSuperChat(forgetOmnigentMemoryClaim(client, email, superSessionId, input.claimId));
  return { ok: true as const };
}

function mapDailyNote(note: OmnigentDailyNote, secrets: string[]) {
  return {
    date: note.date,
    sections: Object.fromEntries(
      Object.entries(note.sections).map(([key, text]) => [
        key,
        redactMemoryProfile(text, secrets) ?? "",
      ]),
    ),
    editedByPerson: note.edited_by_person,
    finalized: note.finalized,
    updatedAt: note.updated_at,
  };
}

/** `memory.dailyNotes`: the person's recent daily notes (engine, per owner). */
export async function listDailyNotes(
  deps: ActivitiesDeps,
  actor: Actor,
  input: { botId: string; limit: number },
  env: NodeJS.ProcessEnv = process.env,
) {
  const client = requireClient(env, actor);
  const { email } = await requireSuperChat(deps, actor, input.botId);
  const notes = await onSuperChat(listOmnigentDailyNotes(client, email, input.limit));
  return { notes: notes.map((note) => mapDailyNote(note, client.secrets ?? [])) };
}

/** `memory.saveDailyNote`: the person's edit of one day's note. */
export async function saveDailyNote(
  deps: ActivitiesDeps,
  actor: Actor,
  input: { botId: string; date: string; sections: Record<string, string> },
  env: NodeJS.ProcessEnv = process.env,
) {
  const client = requireClient(env, actor);
  const { email } = await requireSuperChat(deps, actor, input.botId);
  const note = await onSuperChat(putOmnigentDailyNote(client, email, input.date, input.sections));
  return mapDailyNote(note, client.secrets ?? []);
}
