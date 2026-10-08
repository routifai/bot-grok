// Nova owns the person's timezone; the engine keeps a copy in its per-owner preferences
// (`/v1/me/proactivity`) for the Muse's local-time line, quiet hours and scheduled runs created
// without a timezone. Best-effort: a failed sync never blocks the caller.
import {
  omnigentClientConfigFromEnv,
  omnigentClientFor,
  putOmnigentTimezone,
} from "@nova/adapters";
import type { Actor } from "@nova/contracts";
import type { PrismaClient } from "@nova/db";
import { getLogger } from "@nova/logging";

export async function syncEngineTimezone(
  prisma: Pick<PrismaClient, "user">,
  actor: Pick<Actor, "userId" | "spaceId">,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const connection = omnigentClientConfigFromEnv(env);
  if (!connection) return;
  try {
    const user = await prisma.user.findUnique({
      where: { id: actor.userId },
      select: { email: true, timezone: true },
    });
    if (user?.timezone) {
      await putOmnigentTimezone(
        omnigentClientFor(connection, actor.spaceId),
        user.email,
        user.timezone,
      );
    }
  } catch (error) {
    getLogger().error("engine timezone sync failed, continuing", error);
  }
}
