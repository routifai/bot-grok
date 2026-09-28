import type { JobPublisher } from "@aiden/adapter-kit";
import { runContinueJob } from "@aiden/adapter-kit";
import type { PrismaClient } from "@aiden/db";

/** After a reply that asked in text: make that offer properly, then stay silent. */
export const SKILL_OFFER_FOLLOW_UP_PROMPT =
  "You just asked in text whether to save that work as a skill. Instead, call offer_skill now " +
  "with a SKILL.md for the task you just finished (generic steps, no account names), so the " +
  "person gets Save / Not now buttons. Then your entire reply must be exactly NO_RESPONSE.";

/** After multi-step work: decide whether it's worth a skill, offer if so, stay silent. */
export const SKILL_OFFER_REVIEW_PROMPT =
  "Look at the task you just finished. If it is something the person will likely ask for " +
  "again (a recurring report, a lookup, a routine chore) and no saved skill already covers it, " +
  "call offer_skill with a SKILL.md for it (generic steps, no account names). Otherwise do " +
  "nothing. Either way, your entire reply must be exactly NO_RESPONSE.";

/** Tools that mean the Muse did real work, as opposed to messaging or bookkeeping. */
export const WORK_TOOLS = new Set([
  "web_search",
  "web_fetch",
  "browser_navigate",
  "browser_snapshot",
  "browser_act",
  "computer_observe",
  "computer_act",
  "shell",
  "write_file",
  "read_file",
  "run_subagent",
]);
/** A turn with at least this many work tool calls counts as multi-step. */
const MULTI_STEP_TOOL_CALLS = 3;
/** At most one offer per bot in this window, so offers don't nag. */
const OFFER_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * Some models answer "offer a skill" by asking in their reply text instead of calling
 * offer_skill. Spot a final reply that ends by asking to save something as a skill.
 */
export function replyAsksToSaveSkill(text: string): boolean {
  const paragraphs = text.trim().split(/\n\s*\n/);
  const last = paragraphs[paragraphs.length - 1] ?? "";
  return (
    /\bskills?\b/i.test(last) && /\b(save|keep|store|turn)\b/i.test(last) && /\?\s*$/.test(last)
  );
}

/**
 * After a Muse turn, queue one quiet skill_offer follow-up when it's worth it: the reply asked
 * in text to save a skill, or the turn did multi-step work. Skipped when the turn already
 * offered, saved or used a skill, or when this bot made an offer recently. The follow-up sees
 * the conversation, so any skill is written with full context; it ends silently.
 */
export async function queueSkillOfferFollowUp(
  deps: { prisma: PrismaClient; jobs: Pick<JobPublisher, "enqueue"> },
  run: { id: string; spaceId: string; botId: string; threadId: string; userId: string },
  options: { askedInText: boolean; request?: string; now?: Date },
): Promise<boolean> {
  const tools = await deps.prisma.event.findMany({
    where: { runId: run.id, type: "agent.tool.completed" },
    select: { payload: true },
  });
  const names = tools.map((event) => (event.payload as { name?: unknown } | null)?.name);
  if (
    names.some((name) => name === "offer_skill" || name === "skill_create" || name === "skill_read")
  ) {
    return false;
  }
  const workCalls = names.filter((name) => typeof name === "string" && WORK_TOOLS.has(name)).length;
  if (!options.askedInText && workCalls < MULTI_STEP_TOOL_CALLS) return false;

  const now = options.now ?? new Date();
  const recentOffer = await deps.prisma.run.findFirst({
    where: {
      botId: run.botId,
      trigger: "skill_offer",
      createdAt: { gt: new Date(now.getTime() - OFFER_COOLDOWN_MS) },
    },
    select: { id: true },
  });
  if (recentOffer) return false;

  const followUp = await deps.prisma.$transaction(async (tx) => {
    const task = await tx.task.create({
      data: {
        spaceId: run.spaceId,
        botId: run.botId,
        threadId: run.threadId,
        userId: run.userId,
        prompt: [
          options.askedInText ? SKILL_OFFER_FOLLOW_UP_PROMPT : SKILL_OFFER_REVIEW_PROMPT,
          options.request?.trim()
            ? `The request you just finished: "${options.request.trim().slice(0, 600)}"`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
        status: "queued",
      },
    });
    return tx.run.create({
      data: {
        spaceId: run.spaceId,
        botId: run.botId,
        threadId: run.threadId,
        taskId: task.id,
        userId: run.userId,
        status: "queued",
        trigger: "skill_offer",
      },
      select: { id: true },
    });
  });
  await deps.jobs.enqueue(runContinueJob(followUp.id));
  return true;
}
