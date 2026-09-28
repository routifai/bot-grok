import type { MessageBlock } from "@aiden/contracts";
import { buildSkillMd, parseSkillMd } from "@aiden/core";
import type { PrismaClient } from "@aiden/db";
import { appendEventInTransaction, createThreadMessageInTransaction } from "@aiden/db";

/** Match the agent skill bounds (CreateAgentSkillInput). */
const MAX_SKILL_CONTENT_CHARS = 100_000;

export type SkillOfferDeps = {
  prisma: PrismaClient;
  events?: { notify(threadId: string, seq: number): Promise<void> };
};

export type SkillOfferScope = { spaceId: string; botId: string; userId: string; runId: string };

/**
 * `offer_skill`: the Muse proposes saving what it just did as an agent skill. Nothing is
 * saved here; it posts a Save / Not now Ask into the Conversation carrying the SKILL.md,
 * and `asks.answer` creates the skill only if the person picks Save.
 */
export async function offerSkillFromTool(
  deps: SkillOfferDeps,
  scope: SkillOfferScope,
  input: { content?: string; why?: string },
): Promise<Record<string, unknown>> {
  const parsed = parseSkillMd(String(input.content ?? ""));
  if ("error" in parsed) return { error: parsed.error };
  const content = buildSkillMd(parsed);
  if (content.length > MAX_SKILL_CONTENT_CHARS) {
    return { error: `Skill content must be at most ${MAX_SKILL_CONTENT_CHARS} characters.` };
  }

  const existing = await deps.prisma.agentSkill.findFirst({
    where: { spaceId: scope.spaceId, userId: scope.userId, name: parsed.name },
    select: { name: true },
  });
  if (existing) {
    return {
      error: `A skill named "${existing.name}" is already saved. Use skill_update if it should change.`,
    };
  }

  const conversation = await deps.prisma.thread.findUnique({
    where: { botId: scope.botId },
    select: { id: true },
  });
  if (!conversation) return { error: "No Conversation to post the offer in." };
  const threadId = conversation.id;

  const why = input.why?.trim();
  const block: MessageBlock = {
    kind: "ask",
    text: `Save "${parsed.name}" as a skill?`,
    detail: [why, parsed.description].filter(Boolean).join("\n"),
    status: "pending",
    actions: [
      { id: "save", label: "Save skill" },
      { id: "dismiss", label: "Not now" },
    ],
    skillOffer: { name: parsed.name, description: parsed.description, content },
  };

  const event = await deps.prisma.$transaction(async (tx) => {
    const message = await createThreadMessageInTransaction(tx, {
      threadId,
      role: "bot",
      blocks: [block],
      botId: scope.botId,
      runId: scope.runId,
    });
    return appendEventInTransaction(tx, {
      spaceId: scope.spaceId,
      threadId,
      botId: scope.botId,
      runId: scope.runId,
      type: "thread.message.created",
      payload: { messageId: message.id, role: "bot", blocks: [block] },
    });
  });
  await deps.events?.notify(threadId, event.seq).catch(() => undefined);
  return {
    ok: true,
    offered: parsed.name,
    hint: "Offer posted. Don't also call skill_create; it is saved only if they choose Save.",
  };
}
