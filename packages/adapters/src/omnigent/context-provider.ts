// Omnigent context-provider hook (docs/omnigent-spike.md): composes the `<deployment_context>`
// instructions Omnigent asks Nova for on every turn. Reuses the same builders the existing
// run executor uses (packages/adapters/src/executor/run-prompt.ts, memory-context.ts,
// muse/goals-context.ts, packages/core's episode ranking) rather than re-authoring them, so
// the two engines stay behaviorally aligned while NOVA_ENGINE=omnigent is a spike.
//
// Scope isolation: `nova.scope !== "private"` (a future shared/project scope) gets only the
// static Muse voice/goals instructions — no durable memory, scratchpad, Goals, or episodes.
// See context-provider.test.ts's canary-string tests for the isolation guarantee.
import type { AdapterContext, MemoryStore } from "@aiden/adapter-kit";
import {
  formatSkillsCatalogInstruction,
  rankEpisodes,
  redactSecrets,
  renderEpisodesContext,
} from "@aiden/core";
import { createGoalRepos, type PrismaClient } from "@aiden/db";
import {
  MUSE_GOALS_INSTRUCTION,
  MUSE_VOICE_INSTRUCTION,
  runIdentityInstruction,
} from "../executor/run-prompt.js";
import { loadAgentMemoryContext } from "../memory-context.js";
import { loadGoalsContext } from "../muse/goals-context.js";
import { loadAgentScratchpadContext } from "../scratchpad-context.js";
import { listAgentSkillRecords } from "../skill-tools.js";
import { parsePlaybook } from "../teaching-session.js";

/** Hard cap on the composed instructions (docs/omnigent-spike.md, week 1 contract). */
const MAX_CONTEXT_BYTES = 48 * 1024;
const EPISODES_LOOKBACK = 300;
const EPISODES_LIMIT = 3;
const TAUGHT_SKILLS_LIMIT = 20;

export interface OmnigentContextDeps {
  prisma: PrismaClient;
  memory: MemoryStore;
  /** Secret values scrubbed from composed context, same list the run executor redacts with. */
  secrets: string[];
}

export interface ComposeOmnigentContextInput {
  /** Session labels Nova set at session-create time: nova.user/nova.space/nova.bot/nova.scope. */
  labels: Record<string, string>;
  /** The turn's message text, used only to rank past episodes. */
  turnInput: string;
  /**
   * The session owner Omnigent's server resolved (the identity Nova sent as X-Forwarded-Email).
   * When present it must be the labelled person's email, so labels alone never pick whose context
   * is returned.
   */
  ownerEmail?: string | null;
}

/**
 * Builds the instructions string Nova hands back to Omnigent's context-provider hook. Returns
 * `""` whenever the person cannot be resolved (missing/unknown labels, bot does not belong to
 * that user/space) so an unrecognized session gets no context rather than an error.
 */
export async function composeOmnigentContext(
  deps: OmnigentContextDeps,
  input: ComposeOmnigentContextInput,
): Promise<string> {
  const userId = input.labels["nova.user"];
  const spaceId = input.labels["nova.space"];
  const botId = input.labels["nova.bot"];
  const scope = input.labels["nova.scope"] || "private";
  if (!userId || !spaceId || !botId) return "";

  const bot = await deps.prisma.bot.findUnique({
    where: { id: botId },
    select: {
      id: true,
      userId: true,
      spaceId: true,
      name: true,
      title: true,
      description: true,
      instructions: true,
    },
  });
  if (!bot || bot.userId !== userId || bot.spaceId !== spaceId) return "";
  if (input.ownerEmail) {
    const owner = await deps.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (owner?.email.toLowerCase() !== input.ownerEmail.toLowerCase()) return "";
  }

  const botInstructions = runIdentityInstruction(bot, "user");
  const staticInstructions = [MUSE_VOICE_INSTRUCTION, MUSE_GOALS_INSTRUCTION].join("\n\n");

  if (scope !== "private") {
    return capToBytes(
      [botInstructions, staticInstructions].filter(Boolean).join("\n\n"),
      MAX_CONTEXT_BYTES,
    );
  }

  const context: AdapterContext = {
    operationId: `omnigent-context:${botId}`,
    traceId: `omnigent-context:${botId}`,
    spaceId,
    userId,
    botId,
    signal: AbortSignal.timeout(1_500),
  };

  const [
    user,
    memoryContext,
    scratchpadContext,
    goalsContext,
    episodesContext,
    savedSkills,
    agentSkills,
  ] = await Promise.all([
    deps.prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } }),
    loadAgentMemoryContext(deps.memory, botId, context),
    loadAgentScratchpadContext(deps, { spaceId, botId }),
    loadGoalsContext({ goals: createGoalRepos(deps.prisma) }, { botId }),
    loadEpisodesContext(deps, { botId, query: input.turnInput }),
    deps.prisma.taughtSkill.findMany({ where: { botId, spaceId, status: "saved" } }),
    listAgentSkillRecords(deps.prisma, { spaceId, userId }),
  ]);

  const taughtSkillsLine = formatTaughtSkillsLine(savedSkills);
  const agentSkillsLine = formatSkillsCatalogInstruction(agentSkills);
  const currentTimeLine = formatCurrentTimeInPersonTimezone(new Date(), user?.timezone || "UTC");

  const parts = [
    botInstructions,
    memoryContext ? redactSecrets(memoryContext, deps.secrets) : undefined,
    scratchpadContext ? redactSecrets(scratchpadContext, deps.secrets) : undefined,
    goalsContext ? redactSecrets(goalsContext, deps.secrets) : undefined,
    episodesContext ? redactSecrets(episodesContext, deps.secrets) : undefined,
    taughtSkillsLine,
    agentSkillsLine,
    currentTimeLine,
    staticInstructions,
  ].filter((part): part is string => Boolean(part));

  return capToBytes(parts.join("\n\n"), MAX_CONTEXT_BYTES);
}

async function loadEpisodesContext(
  deps: Pick<OmnigentContextDeps, "prisma">,
  input: { botId: string; query: string },
): Promise<string | undefined> {
  const episodes = await deps.prisma.episode.findMany({
    where: { botId: input.botId },
    orderBy: { createdAt: "desc" },
    take: EPISODES_LOOKBACK,
    select: { title: true, summary: true, links: true, createdAt: true },
  });
  const ranked = rankEpisodes(input.query, episodes, { limit: EPISODES_LIMIT });
  return renderEpisodesContext(ranked);
}

function formatTaughtSkillsLine(
  skills: Array<{ name: string; goal: string; playbook: unknown }>,
): string | undefined {
  const index = skills.slice(0, TAUGHT_SKILLS_LIMIT);
  if (index.length === 0) return undefined;
  return `Saved taught skills:\n${index
    .map((skill) => {
      const playbook = parsePlaybook(skill.playbook);
      const name = skill.name || skill.goal.slice(0, 80);
      return `- ${name}: ${playbook.whenToUse || skill.goal}`;
    })
    .join(
      "\n",
    )}\nWhen the user asks to run a taught skill by name, follow that skill's playbook exactly. The full playbook is included in the user task when they invoke it.`;
}

function formatCurrentTimeInPersonTimezone(now: Date, timezone: string): string {
  let formatted: string;
  try {
    formatted = new Intl.DateTimeFormat("en-US", {
      dateStyle: "full",
      timeStyle: "long",
      timeZone: timezone,
    }).format(now);
  } catch {
    formatted = `${now.toISOString()} (UTC)`;
  }
  return `Current date and time for this person (${timezone}): ${formatted}. Treat this as the present moment; write absolute dates rather than relative ones.`;
}

function capToBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const characters: string[] = [];
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    characters.push(character);
    bytes += characterBytes;
  }
  return characters.join("");
}
