// Applying a decision on a GoalProposal (CONTEXT.md "Proposal"; docs/muse/PLAN.md B4).
// Adapted from OpenMuse (MIT) — openmuse/goals/store.py (accept_proposal / dismiss_proposal).
//
// This is the one place a Proposal's accept/dismiss/withdraw is applied, so the `goals`
// tool's `propose` action (withdrawing a stale proposal) and B6's `goals.acceptProposal` /
// `dismissProposal` RPCs (and B9's `asks.answer`) all go through the same logic instead of
// each re-implementing the plan-replacement rules.
import {
  type Goal,
  GoalProposalTaskSchema,
  MessageBlock as MessageBlockSchema,
} from "@aiden/contracts";
import {
  appendEventInTransaction,
  createGoalRepos,
  type Prisma,
  type PrismaClient,
} from "@aiden/db";

export type GoalAnswerDeps = {
  prisma: PrismaClient;
  /** Realtime fan-out for the Conversation thread the Ask lived in. */
  events?: { notify(threadId: string, seq: number): Promise<void> };
};

type NotifyTarget = { threadId: string; seq: number } | null;

type MinimalGoal = { id: string; spaceId: string; botId: string };
type MinimalProposal = { id: string; goalId: string; askMessageId: string | null };

/** Marks the Proposal's Ask block answered so it stops showing as open everywhere it appears. */
async function markProposalAskAnswered(
  tx: Prisma.TransactionClient,
  proposal: MinimalProposal,
  goal: MinimalGoal,
  answer: "accept" | "dismiss" | "withdrawn",
): Promise<NotifyTarget> {
  if (!proposal.askMessageId) return null;
  const message = await tx.message.findUnique({ where: { id: proposal.askMessageId } });
  if (!message) return null;
  const parsed = MessageBlockSchema.array().safeParse(message.blocks);
  if (!parsed.success) return null;

  let changed = false;
  const blocks = parsed.data.map((block) => {
    if (block.kind === "ask" && block.status !== "answered") {
      changed = true;
      return { ...block, status: "answered" as const, answer };
    }
    return block;
  });
  if (!changed) return null;

  await tx.message.update({ where: { id: message.id }, data: { blocks } });
  const event = await appendEventInTransaction(tx, {
    spaceId: goal.spaceId,
    threadId: message.threadId,
    botId: message.botId ?? goal.botId,
    type: "thread.message.updated",
    payload: { messageId: message.id, role: "bot", blocks },
  });
  return { threadId: event.threadId, seq: event.seq };
}

/** Withdraws a Goal's open Proposal (if any) ahead of a new one replacing it. */
export async function withdrawOpenProposal(
  tx: Prisma.TransactionClient,
  goal: MinimalGoal,
): Promise<NotifyTarget> {
  const proposal = await tx.goalProposal.findFirst({ where: { goalId: goal.id, status: "open" } });
  if (!proposal) return null;
  await tx.goalProposal.update({
    where: { id: proposal.id },
    data: { status: "withdrawn", decidedAt: new Date() },
  });
  return markProposalAskAnswered(tx, proposal, goal, "withdrawn");
}

async function applyProposalDecision(
  tx: Prisma.TransactionClient,
  proposalId: string,
  decision: "accept" | "dismiss",
): Promise<{ goal: Goal; notify: NotifyTarget } | null> {
  const proposal = await tx.goalProposal.findFirst({ where: { id: proposalId, status: "open" } });
  if (!proposal) return null;
  const goal = await tx.goal.findUnique({ where: { id: proposal.goalId } });
  if (!goal) return null;

  if (decision === "accept") {
    const proposedTasks = GoalProposalTaskSchema.array().min(1).parse(proposal.tasks);
    const existingTasks = await tx.goalTask.findMany({ where: { goalId: goal.id } });
    const keepIds = new Set(
      proposedTasks.map((task) => task.keepTaskId).filter((id): id is string => Boolean(id)),
    );
    const dropped = existingTasks.filter((task) => !keepIds.has(task.id));
    if (dropped.length > 0) {
      await tx.goalTask.deleteMany({ where: { id: { in: dropped.map((task) => task.id) } } });
    }
    for (const [idx, proposed] of proposedTasks.entries()) {
      const kept = proposed.keepTaskId
        ? existingTasks.find((task) => task.id === proposed.keepTaskId)
        : undefined;
      if (kept) {
        // Carried over unchanged: only its position moves, not its title/status/note.
        await tx.goalTask.update({ where: { id: kept.id }, data: { idx } });
      } else {
        await tx.goalTask.create({
          data: { goalId: goal.id, idx, title: proposed.title, status: "pending", note: "" },
        });
      }
    }
  }

  await tx.goalProposal.update({
    where: { id: proposal.id },
    data: { status: decision === "accept" ? "accepted" : "dismissed", decidedAt: new Date() },
  });

  const notify = await markProposalAskAnswered(tx, proposal, goal, decision);

  const repos = createGoalRepos(tx as unknown as PrismaClient);
  const mapped = await repos.getGoal(goal.id);
  if (!mapped) return null;
  return { goal: mapped, notify };
}

async function decideGoalProposal(
  deps: GoalAnswerDeps,
  proposalId: string,
  decision: "accept" | "dismiss",
): Promise<Goal | null> {
  const committed = await deps.prisma.$transaction((tx) =>
    applyProposalDecision(tx, proposalId, decision),
  );
  if (!committed) return null;
  if (committed.notify) {
    await deps.events
      ?.notify(committed.notify.threadId, committed.notify.seq)
      .catch(() => undefined);
  }
  return committed.goal;
}

/**
 * Accept an open Proposal: replace the Goal's plan with the proposed tasks, keeping the
 * status and note of every task carried over by `keepTaskId`. Returns null when the
 * proposal no longer exists or is no longer open (already decided or withdrawn).
 */
export function acceptGoalProposal(deps: GoalAnswerDeps, proposalId: string): Promise<Goal | null> {
  return decideGoalProposal(deps, proposalId, "accept");
}

/** Dismiss an open Proposal: the Goal's current plan is left exactly as it was. */
export function dismissGoalProposal(
  deps: GoalAnswerDeps,
  proposalId: string,
): Promise<Goal | null> {
  return decideGoalProposal(deps, proposalId, "dismiss");
}
