// The Super Chat session behind a Muse, shared by the capabilities that read the person's
// Conversation family from the engine (activity, memory, daily notes): the engine client for the
// actor's space, and the Muse's own session id, email and timezone.
import {
  type OmnigentClientConfig,
  omnigentClientConfigFromEnv,
  omnigentClientFor,
} from "@nova/adapters";
import type { Actor } from "@nova/contracts";
import type { PrismaClient } from "@nova/db";
import { ORPCError } from "@orpc/server";

export interface SuperChatDeps {
  prisma: PrismaClient;
}

/** The engine client for the actor's space (the tenant every engine call carries). */
export function requireClient(env: NodeJS.ProcessEnv, actor: Actor): OmnigentClientConfig {
  const connection = omnigentClientConfigFromEnv(env);
  if (!connection) {
    throw new ORPCError("BAD_REQUEST", { message: "Chat is not available right now." });
  }
  return omnigentClientFor(connection, actor.spaceId);
}

export async function requireSuperChat(
  deps: SuperChatDeps,
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
