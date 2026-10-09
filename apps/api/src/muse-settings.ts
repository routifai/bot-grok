import {
  getOmnigentProactivity,
  type OmnigentClientConfig,
  type OmnigentProactivity,
  omnigentClientConfigFromEnv,
  omnigentClientFor,
  putOmnigentProactivity,
} from "@nova/adapters";
import type { Actor, MuseSettings } from "@nova/contracts";
import { resolveMuseSettings } from "@nova/core";
import { IsolationError, type PrismaClient } from "@nova/db";
import { getLogger } from "@nova/logging";
import { ORPCError } from "@orpc/server";

// muse.settings / muse.updateSettings (packages/contracts/src/rpc/muse.ts, docs/muse/PLAN.md B7).
//
// The settings are the person's engine preferences (`/v1/me/proactivity`, ADR 0009): the engine
// gates every proactive run with them, so it is the only copy. Without an engine there is
// nothing to read or save, so the routes answer SERVICE_UNAVAILABLE. The Bot columns
// (museProactivity / museQuietHours) are only read once, to carry values set before ADR 0009
// over; NULL there means "never set" and the empty string was quiet hours turned off.

export interface MuseSettingsDeps {
  prisma: PrismaClient;
}

type BotSettingsRow = { museProactivity: string | null; museQuietHours: string | null };

/** The Muse's bot must belong to the actor's space and user, like every other bot-scoped route. */
async function requireOwnBot(
  deps: MuseSettingsDeps,
  actor: Actor,
  botId: string,
): Promise<BotSettingsRow> {
  const bot = await deps.prisma.bot.findFirst({
    where: { id: botId, spaceId: actor.spaceId, userId: actor.userId },
    select: { museProactivity: true, museQuietHours: true },
  });
  if (!bot) throw new IsolationError();
  return bot;
}

interface Engine {
  client: OmnigentClientConfig;
  email: string;
}

async function engineOf(
  deps: MuseSettingsDeps,
  actor: Actor,
  env: NodeJS.ProcessEnv,
): Promise<Engine> {
  const connection = omnigentClientConfigFromEnv(env);
  if (!connection) {
    throw new ORPCError("SERVICE_UNAVAILABLE", { message: "Muse settings need the engine" });
  }
  const user = await deps.prisma.user.findUnique({
    where: { id: actor.userId },
    select: { email: true },
  });
  if (!user) throw new IsolationError();
  return { client: omnigentClientFor(connection, actor.spaceId), email: user.email };
}

function fromEngine(prefs: OmnigentProactivity): MuseSettings {
  return {
    proactivity: prefs.proactivity,
    quietHours:
      prefs.quiet_start && prefs.quiet_end ? `${prefs.quiet_start}-${prefs.quiet_end}` : null,
  };
}

function toEngine(patch: Partial<MuseSettings>): Parameters<typeof putOmnigentProactivity>[2] {
  const body: Parameters<typeof putOmnigentProactivity>[2] = {};
  if (patch.proactivity !== undefined) body.proactivity = patch.proactivity;
  if (patch.quietHours !== undefined) {
    const [start = null, end = null] = patch.quietHours?.split("-") ?? [];
    body.quiet_start = start;
    body.quiet_end = end;
  }
  return body;
}

/** The engine's values when the person never set any. */
const isEngineDefault = (prefs: OmnigentProactivity) =>
  prefs.proactivity === "normal" && prefs.quiet_start === null && prefs.quiet_end === null;

/**
 * One-time carry-over of settings saved on Bot before the engine owned them: when the person
 * changed them in Nova and the engine still has its defaults, they are pushed once. Either way
 * the Bot columns are then cleared, so this never runs again for that Muse and a later engine
 * value is never overwritten. Best-effort: a failure leaves the columns for the next read.
 */
async function carryOverBotSettings(
  deps: MuseSettingsDeps,
  engine: Engine,
  botId: string,
  bot: BotSettingsRow,
  prefs: OmnigentProactivity,
): Promise<OmnigentProactivity> {
  if (bot.museProactivity === null && bot.museQuietHours === null) return prefs;
  try {
    const pushed = isEngineDefault(prefs)
      ? await putOmnigentProactivity(
          engine.client,
          engine.email,
          toEngine(resolveMuseSettings(bot)),
        )
      : prefs;
    await deps.prisma.bot.update({
      where: { id: botId },
      data: { museProactivity: null, museQuietHours: null },
    });
    return pushed;
  } catch (error) {
    getLogger().error("muse settings: carrying Nova settings to the engine failed", error);
    return prefs;
  }
}

export async function getMuseSettings(
  deps: MuseSettingsDeps,
  actor: Actor,
  botId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<MuseSettings> {
  const bot = await requireOwnBot(deps, actor, botId);
  const engine = await engineOf(deps, actor, env);
  const prefs = await getOmnigentProactivity(engine.client, engine.email);
  return fromEngine(await carryOverBotSettings(deps, engine, botId, bot, prefs));
}

export async function updateMuseSettings(
  deps: MuseSettingsDeps,
  actor: Actor,
  input: { botId: string } & Partial<MuseSettings>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<MuseSettings> {
  const { botId, ...patch } = input;
  const bot = await requireOwnBot(deps, actor, botId);
  const engine = await engineOf(deps, actor, env);
  const saved = await putOmnigentProactivity(engine.client, engine.email, toEngine(patch));
  if (bot.museProactivity !== null || bot.museQuietHours !== null) {
    // The person chose on the engine: the pre-engine values must never be carried over.
    await deps.prisma.bot.update({
      where: { id: botId },
      data: { museProactivity: null, museQuietHours: null },
    });
  }
  return fromEngine(saved);
}
