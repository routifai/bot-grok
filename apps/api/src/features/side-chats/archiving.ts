import {
  getOmnigentArchiving,
  type OmnigentArchiving,
  omnigentClientConfigFromEnv,
  omnigentClientFor,
  putOmnigentArchiving,
} from "@nova/adapters";
import type { Actor, Archiving, ArchivingUpdate } from "@nova/contracts";
import { IsolationError, type PrismaClient } from "@nova/db";
import { ORPCError } from "@orpc/server";

// muse.archiving / muse.updateArchiving: the person's side chat auto-archive setting. The engine
// owns it (`/v1/me/archiving`, ADR 0009) and runs the sweep; this only proxies, scoped to the
// actor's own bot like the other Muse settings.

export interface ArchivingDeps {
  prisma: PrismaClient;
}

async function engineOf(deps: ArchivingDeps, actor: Actor, botId: string, env: NodeJS.ProcessEnv) {
  const bot = await deps.prisma.bot.findFirst({
    where: { id: botId, spaceId: actor.spaceId, userId: actor.userId },
    select: { id: true },
  });
  if (!bot) throw new IsolationError();
  const connection = omnigentClientConfigFromEnv(env);
  if (!connection) return null;
  const user = await deps.prisma.user.findUnique({
    where: { id: actor.userId },
    select: { email: true },
  });
  if (!user) throw new IsolationError();
  return { client: omnigentClientFor(connection, actor.spaceId), email: user.email };
}

function toArchiving(saved: OmnigentArchiving): Archiving {
  return {
    sideChatAutoArchiveDays: saved.side_chat_auto_archive_days,
    defaultDays: saved.default_days,
  };
}

export async function getArchiving(
  deps: ArchivingDeps,
  actor: Actor,
  botId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Archiving> {
  const engine = await engineOf(deps, actor, botId, env);
  if (!engine) return { sideChatAutoArchiveDays: null, defaultDays: 30 };
  const saved = await getOmnigentArchiving(engine.client, engine.email);
  return toArchiving(saved);
}

export async function updateArchiving(
  deps: ArchivingDeps,
  actor: Actor,
  input: { botId: string } & ArchivingUpdate,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Archiving> {
  const engine = await engineOf(deps, actor, input.botId, env);
  if (!engine) throw new ORPCError("PRECONDITION_FAILED", { message: "engine unavailable" });
  const saved = await putOmnigentArchiving(engine.client, engine.email, {
    side_chat_auto_archive_days: input.sideChatAutoArchiveDays,
  });
  return toArchiving(saved);
}
