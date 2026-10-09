import { getOmnigentMuse, type OmnigentClientConfig } from "@nova/adapters";
import type { Actor } from "@nova/contracts";
import type { PrismaClient } from "@nova/db";
import { ORPCError } from "@orpc/server";

/** The caller's Muse session on the engine (created there when the person has none yet), plus
 * the identity every engine call carries. */
export async function resolveMuseSession(
  deps: { prisma: PrismaClient },
  client: OmnigentClientConfig,
  actor: Actor,
): Promise<{ email: string; sessionId: string }> {
  const user = await deps.prisma.user.findUnique({
    where: { id: actor.userId },
    select: { email: true },
  });
  if (!user) throw new ORPCError("UNAUTHORIZED");
  const muse = await getOmnigentMuse(client, user.email);
  return { email: user.email, sessionId: muse.session_id };
}
