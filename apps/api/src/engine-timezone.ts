// Nova owns the person's timezone; the engine keeps a copy in its per-owner preferences for the
// Muse's local-time line and for scheduled runs created without a timezone. Best-effort: a
// failed sync never blocks the caller.
import { omnigentClientConfigFromEnv, putOmnigentTimezone } from "@aiden/adapters";
import type { PrismaClient } from "@aiden/db";
import { getLogger } from "@aiden/logging";

export async function syncEngineTimezone(
  prisma: Pick<PrismaClient, "user">,
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const client = omnigentClientConfigFromEnv(env);
  if (!client) return;
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, timezone: true },
    });
    if (user?.timezone) await putOmnigentTimezone(client, user.email, user.timezone);
  } catch (error) {
    getLogger().error("engine timezone sync failed, continuing", error);
  }
}
