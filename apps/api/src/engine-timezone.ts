// Nova owns the person's timezone; the engine keeps a copy in its per-owner preferences for the
// Muse's local-time line and for scheduled runs created without a timezone. Best-effort: a
// failed sync never blocks the caller.
import {
  omnigentClientConfigFromEnv,
  putOmnigentProactivity,
  putOmnigentTimezone,
} from "@aiden/adapters";
import type { MuseSettings } from "@aiden/contracts";
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

/** The engine's levels are off, low and normal; Nova's "high" runs at the engine's top level. */
const ENGINE_LEVEL = { off: "off", low: "low", normal: "normal", high: "normal" } as const;

/** Copies the Muse's proactivity level and quiet hours ("22:00-08:00") to the engine, which gates
 * every proactive run with them. Best-effort, like the timezone. */
export async function syncEngineProactivity(
  prisma: Pick<PrismaClient, "user">,
  userId: string,
  settings: MuseSettings,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const client = omnigentClientConfigFromEnv(env);
  if (!client) return;
  try {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (!user) return;
    const [quietStart = null, quietEnd = null] = settings.quietHours?.split("-") ?? [];
    await putOmnigentProactivity(client, user.email, {
      proactivity: ENGINE_LEVEL[settings.proactivity],
      quietStart,
      quietEnd,
    });
  } catch (error) {
    getLogger().error("engine proactivity sync failed, continuing", error);
  }
}
