import type { Actor, MuseSettings } from "@aiden/contracts";
import { resolveMuseSettings } from "@aiden/core";
import { IsolationError, type PrismaClient } from "@aiden/db";

// Real muse.settings / muse.updateSettings handlers (packages/contracts/src/rpc.ts,
// docs/muse/PLAN.md B7).
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
  return resolveMuseSettings(await requireOwnBot(deps, actor, botId));
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
  return resolveMuseSettings(bot);
}
