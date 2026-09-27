import type { Actor, MuseSettings, Proactivity } from "@aiden/contracts";
import { DEFAULT_MUSE_SETTINGS, PROACTIVITY_LEVELS } from "@aiden/contracts";
import { IsolationError, type PrismaClient } from "@aiden/db";

// Real muse.settings / muse.updateSettings handlers (packages/contracts/src/rpc.ts),
// replacing the "settings" part of muse-preview.ts (docs/muse/PLAN.md, B7).
//
// Persistence: two nullable columns on Bot (packages/db/prisma/schema.prisma,
// museProactivity / museQuietHours) rather than a new table. Every other per-bot setting
// (voiceId, autoSpeak, modelProvider, thinkingLevel, teamChatRules, ...) already lives as
// flat scalar columns directly on Bot, so this is the existing per-bot settings location
// the plan asks to prefer, and a Muse has exactly one bot row (ADR 0001) so there's no
// need for a keyed settings table.
//
// museProactivity NULL means "use DEFAULT_MUSE_SETTINGS.proactivity". museQuietHours NULL
// means "use DEFAULT_MUSE_SETTINGS.quietHours"; the empty string "" is a separate, explicit
// "quiet hours turned off" (MuseSettings.quietHours: null in the contract) so it round-trips
// distinctly from "never set".

export interface MuseSettingsDeps {
  prisma: PrismaClient;
}

type BotSettingsRow = { museProactivity: string | null; museQuietHours: string | null };

function isProactivity(value: string | null): value is Proactivity {
  return value !== null && (PROACTIVITY_LEVELS as readonly string[]).includes(value);
}

function toMuseSettings(row: BotSettingsRow): MuseSettings {
  const proactivity = isProactivity(row.museProactivity)
    ? row.museProactivity
    : DEFAULT_MUSE_SETTINGS.proactivity;
  const quietHours =
    row.museQuietHours === null
      ? DEFAULT_MUSE_SETTINGS.quietHours
      : row.museQuietHours === ""
        ? null
        : row.museQuietHours;
  return { proactivity, quietHours };
}

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

export async function getMuseSettings(
  deps: MuseSettingsDeps,
  actor: Actor,
  botId: string,
): Promise<MuseSettings> {
  return toMuseSettings(await requireOwnBot(deps, actor, botId));
}

export async function updateMuseSettings(
  deps: MuseSettingsDeps,
  actor: Actor,
  input: { botId: string } & Partial<MuseSettings>,
): Promise<MuseSettings> {
  const { botId, ...patch } = input;
  await requireOwnBot(deps, actor, botId);
  const data: { museProactivity?: string; museQuietHours?: string } = {};
  if (patch.proactivity !== undefined) data.museProactivity = patch.proactivity;
  if (patch.quietHours !== undefined) data.museQuietHours = patch.quietHours ?? "";
  const bot = await deps.prisma.bot.update({
    where: { id: botId },
    data,
    select: { museProactivity: true, museQuietHours: true },
  });
  return toMuseSettings(bot);
}
