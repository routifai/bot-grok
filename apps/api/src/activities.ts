// Real `activities.*` handlers (packages/contracts/src/rpc.ts, docs/super-chat/WIRING.md slice
// A1): the Activity panel for a Muse's Super Chat family (the Conversation, its Side Chats,
// and their Helpers). Owner-of-the-bot only — unlike `chats.messages`/`chats.send`, there is no
// separate chatId ownership rule here, since the Activity Feed is always read from the Super
// Chat's own session id (Omnigent derives the whole family from it).
import {
  getOmnigentActivity,
  getOmnigentMemoryProfile,
  listOmnigentActivities,
  mapActivity,
  type OmnigentClientConfig,
  omnigentClientConfigFromEnv,
  redactActivity,
  redactMemoryProfile,
} from "@aiden/adapters";
import type { Activity, ActivityPage, Actor } from "@aiden/contracts";
import type { PrismaClient } from "@aiden/db";
import { ORPCError } from "@orpc/server";

export interface ActivitiesDeps {
  prisma: PrismaClient;
}

function requireClient(env: NodeJS.ProcessEnv): OmnigentClientConfig {
  const client = omnigentClientConfigFromEnv(env);
  if (!client) {
    throw new ORPCError("BAD_REQUEST", { message: "Nova is not running on the Omnigent engine" });
  }
  return client;
}

async function requireSuperChat(
  deps: ActivitiesDeps,
  actor: Actor,
  botId: string,
): Promise<{ superSessionId: string; email: string }> {
  const [bot, user] = await Promise.all([
    deps.prisma.bot.findFirst({
      where: { id: botId, spaceId: actor.spaceId, userId: actor.userId },
      select: { id: true },
    }),
    deps.prisma.user.findUnique({ where: { id: actor.userId }, select: { email: true } }),
  ]);
  if (!bot || !user) throw new ORPCError("NOT_FOUND", { message: "Muse not found" });
  const session = await deps.prisma.omnigentSession.findUnique({
    where: { botId },
    select: { omnigentSessionId: true },
  });
  if (!session) {
    throw new ORPCError("NOT_FOUND", { message: "This Muse has no Conversation yet" });
  }
  return { superSessionId: session.omnigentSessionId, email: user.email };
}

export async function listActivities(
  deps: ActivitiesDeps,
  actor: Actor,
  input: { botId: string; before?: number; limit?: number },
  env: NodeJS.ProcessEnv = process.env,
): Promise<ActivityPage> {
  const client = requireClient(env);
  const { superSessionId, email } = await requireSuperChat(deps, actor, input.botId);
  const page = await listOmnigentActivities(client, email, superSessionId, {
    before: input.before,
    limit: input.limit,
  });
  const secrets = client.secrets ?? [];
  return {
    activities: page.data.map((raw) => redactActivity(mapActivity(raw), secrets)),
    hasMore: Boolean(page.has_more),
  };
}

export async function getActivity(
  deps: ActivitiesDeps,
  actor: Actor,
  input: { botId: string; activityId: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<Activity> {
  const client = requireClient(env);
  const { superSessionId, email } = await requireSuperChat(deps, actor, input.botId);
  const activity = await getOmnigentActivity(client, email, superSessionId, input.activityId);
  return redactActivity(mapActivity(activity), client.secrets ?? []);
}

/** `memory.profile`: the Muse's Memory Profile, read from the same Super Chat. */
export async function getMemoryProfile(
  deps: ActivitiesDeps,
  actor: Actor,
  input: { botId: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ profile: string | null }> {
  const client = requireClient(env);
  const { superSessionId, email } = await requireSuperChat(deps, actor, input.botId);
  const result = await getOmnigentMemoryProfile(client, email, superSessionId);
  return { profile: redactMemoryProfile(result.profile, client.secrets ?? []) };
}
