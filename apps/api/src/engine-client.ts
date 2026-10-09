// The engine connection every capability route shares: the engine client for an actor's space,
// the "needs the engine" refusal, and the engine session behind a Muse (its Computer's session).
// Nova runs on the engine (docs/adr/0004-engine-owns-the-computer.md); it keeps no Computer state.
import {
  type OmnigentClientConfig,
  omnigentClientConfigFromEnv,
  omnigentClientFor,
} from "@nova/adapters";
import type { Actor } from "@nova/contracts";
import type { PrismaClient } from "@nova/db";
import { ORPCError } from "@orpc/server";

export interface EngineComputer {
  client: OmnigentClientConfig;
  email: string;
  sessionId: string | null;
  bot: { id: string; screenGeneration: number };
}

/** The engine client for this actor's space (the tenant every engine call carries); `undefined`
 * when no engine is configured. Capability routes pass it through `requireEngine`. */
export function engineComputerClient(
  actor: Pick<Actor, "spaceId">,
  env: NodeJS.ProcessEnv = process.env,
): OmnigentClientConfig | undefined {
  const connection = omnigentClientConfigFromEnv(env);
  return connection ? omnigentClientFor(connection, actor.spaceId) : undefined;
}

/** The engine client, or a clear "not configured" error: Nova runs on the engine, so a route has
 * no fallback to serve without it. `what` names the capability ("Goals", "The Feed"). */
export function requireEngine(
  client: OmnigentClientConfig | undefined,
  what: string,
): OmnigentClientConfig {
  if (!client) throw new ORPCError("SERVICE_UNAVAILABLE", { message: `${what} need the engine` });
  return client;
}

/** The Muse, its owner's email and its engine session, checked against the actor. */
export async function resolveEngineComputer(
  deps: { prisma: PrismaClient },
  client: OmnigentClientConfig,
  actor: Actor,
  botId: string,
): Promise<EngineComputer> {
  const [bot, user, session] = await Promise.all([
    deps.prisma.bot.findFirst({
      where: { id: botId, spaceId: actor.spaceId, userId: actor.userId },
      select: { id: true, screenGeneration: true },
    }),
    deps.prisma.user.findUnique({ where: { id: actor.userId }, select: { email: true } }),
    deps.prisma.omnigentSession.findUnique({
      where: { botId },
      select: { omnigentSessionId: true },
    }),
  ]);
  if (!bot || !user) throw new ORPCError("NOT_FOUND", { message: "Muse not found" });
  return { client, email: user.email, sessionId: session?.omnigentSessionId ?? null, bot };
}

/** The engine session and owner email behind a Muse's Computer, for engine routes that act on
 * it (teaching records it). `sessionId` is `null` until the Muse has had a turn. */
export async function engineSessionOf(
  deps: { prisma: PrismaClient },
  client: OmnigentClientConfig,
  actor: Actor,
  botId: string,
): Promise<{ email: string; sessionId: string | null }> {
  const { email, sessionId } = await resolveEngineComputer(deps, client, actor, botId);
  return { email, sessionId };
}
