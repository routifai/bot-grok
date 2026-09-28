import type { JobPublisher } from "@aiden/adapter-kit";
import { runContinueJob } from "@aiden/adapter-kit";
import type { PrismaClient } from "@aiden/db";

/**
 * The quiet follow-up turn's instruction: offer the skill properly, then stay silent so
 * the only thing the person sees is the Save / Not now card.
 */
export const SKILL_OFFER_FOLLOW_UP_PROMPT =
  "You just asked in text whether to save that work as a skill. Instead, call offer_skill now " +
  "with a SKILL.md for the task you just finished (generic steps, no account names), so the " +
  "person gets Save / Not now buttons. Then your entire reply must be exactly NO_RESPONSE.";

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
 * When a Muse turn asked in text instead of calling offer_skill (and saved nothing), queue one
 * quiet follow-up turn that makes the real offer. It sees the conversation, so the skill is
 * written with full context; it ends silently.
 */
export async function queueSkillOfferFollowUp(
  deps: { prisma: PrismaClient; jobs: Pick<JobPublisher, "enqueue"> },
  run: { id: string; spaceId: string; botId: string; threadId: string; userId: string },
): Promise<boolean> {
  const tools = await deps.prisma.event.findMany({
    where: { runId: run.id, type: "agent.tool.completed" },
    select: { payload: true },
  });
  const handled = tools.some((event) => {
    const name = (event.payload as { name?: unknown } | null)?.name;
    return name === "offer_skill" || name === "skill_create";
  });
  if (handled) return false;
  const followUp = await deps.prisma.$transaction(async (tx) => {
    const task = await tx.task.create({
      data: {
        spaceId: run.spaceId,
        botId: run.botId,
        threadId: run.threadId,
        userId: run.userId,
        prompt: SKILL_OFFER_FOLLOW_UP_PROMPT,
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
