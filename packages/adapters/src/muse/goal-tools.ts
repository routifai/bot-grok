// Handler for the `goals` tool (CONTEXT.md Goal/Task/Proposal; docs/muse/PLAN.md B4).
// Adapted from OpenMuse (MIT) — openmuse/tools/goal_tools.py (action set) and
// openmuse/goals/store.py (create / update_step / propose).
//
// Pattern: scratchpad-tools.ts. Each `*FromTool` function is called directly from the
// executor's tool dispatch (see run-executor.ts, next to scratchpad_add) with plain
// input already coerced from the model's tool-call args.
import {
  type Goal,
  GoalProposalTaskSchema,
  type GoalTaskStatus,
  GoalTaskStatusSchema,
  type MessageBlock,
} from "@aiden/contracts";
import type { Prisma, PrismaClient } from "@aiden/db";
import {
  appendEventInTransaction,
  createGoalRepos,
  createThreadMessageInTransaction,
} from "@aiden/db";
import { withdrawOpenProposal } from "./goal-proposals.js";

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 4_000;
const NOTE_MAX = 4_000;
const MAX_CHECK_IN_CRONS = 8;
const MAX_PROPOSAL_TASKS = 40;

export type GoalToolDeps = {
  prisma: PrismaClient;
  /** Realtime fan-out for the Conversation thread an Ask was posted into. */
  events?: { notify(threadId: string, seq: number): Promise<void> };
};

export type GoalToolScope = {
  spaceId: string;
  botId: string;
  userId: string;
  /**
   * The run this tool call is executing under. Threaded onto every Ask the `goals` tool
   * posts (below) so it names a real run (`asks.answer` / B6 looks the message up by
   * `{id, runId}`) — the run itself need not be paused; a Proposal/blocked-Task Ask is
   * answered by applying its effect directly (goal-proposals.ts, apps/api/src/goals.ts),
   * never by resuming this run.
   */
  runId: string;
};

type NotifyTarget = { threadId: string; seq: number } | null;

type ProposedTaskInput = { title: string; keepTaskId?: string };

function parseDueDate(value: string | undefined): Date | null | "invalid" {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return "invalid";
  const date = new Date(`${trimmed}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? "invalid" : date;
}

function cleanTaskTitles(titles: unknown): string[] {
  if (!Array.isArray(titles)) return [];
  return titles
    .map((title) => (typeof title === "string" ? title.trim() : ""))
    .filter((title) => title.length > 0)
    .map((title) => title.slice(0, TITLE_MAX));
}

/** Posts the plan-change Ask (first plan or a later Proposal) into the Conversation thread. */
async function postProposalAsk(
  tx: Prisma.TransactionClient,
  input: {
    spaceId: string;
    botId: string;
    threadId: string;
    runId: string;
    goalTitle: string;
    reason: string;
    tasks: ProposedTaskInput[];
  },
) {
  const detailLines = input.tasks.map((task, index) => `${index + 1}. ${task.title}`);
  const block: MessageBlock = {
    kind: "ask",
    text: `Accept the plan for "${input.goalTitle}"?`,
    detail: [input.reason, ...detailLines].join("\n"),
    status: "pending",
    actions: [
      { id: "accept", label: "Accept plan" },
      { id: "dismiss", label: "Keep current" },
    ],
  };
  return postAskMessage(tx, input, block);
}

/**
 * Posts a blocked-Task Ask (free-text answer) into the Conversation thread. `goalTaskId`
 * is the explicit marker `asks.answer` (B6) uses to route the answer back onto this Task
 * instead of guessing from the thread/shape (see the contract's `goalTaskId` on the "ask"
 * block).
 */
async function postBlockedTaskAsk(
  tx: Prisma.TransactionClient,
  input: {
    spaceId: string;
    botId: string;
    threadId: string;
    runId: string;
    note: string;
    taskId: string;
  },
) {
  const block: MessageBlock = {
    kind: "ask",
    text: input.note,
    input: "text",
    status: "pending",
    goalTaskId: input.taskId,
  };
  return postAskMessage(tx, input, block);
}

async function postAskMessage(
  tx: Prisma.TransactionClient,
  input: { spaceId: string; botId: string; threadId: string; runId: string },
  block: MessageBlock,
) {
  const message = await createThreadMessageInTransaction(tx, {
    threadId: input.threadId,
    role: "bot",
    blocks: [block],
    botId: input.botId,
    runId: input.runId,
  });
  const event = await appendEventInTransaction(tx, {
    spaceId: input.spaceId,
    threadId: input.threadId,
    botId: input.botId,
    type: "thread.message.created",
    payload: { messageId: message.id, role: "bot", blocks: [block] },
  });
  return { message, event };
}

async function notifyIfNeeded(deps: GoalToolDeps, notify: NotifyTarget): Promise<void> {
  if (!notify) return;
  await deps.events?.notify(notify.threadId, notify.seq).catch(() => undefined);
}

/**
 * `create`: makes the Goal (active, no live Tasks yet) and its first plan as an open
 * Proposal — the person accepts it in the Conversation before any Task exists.
 */
export async function createGoalFromTool(
  deps: GoalToolDeps,
  scope: GoalToolScope,
  input: { title: string; description?: string; due?: string; checkIn?: string[]; tasks: string[] },
): Promise<{ goal: Goal } | { error: string }> {
  const title = (input.title ?? "").trim().slice(0, TITLE_MAX);
  if (!title) return { error: "title is required." };
  const tasks = cleanTaskTitles(input.tasks);
  if (tasks.length === 0) {
    return { error: "tasks must include at least one item for the first plan." };
  }
  const due = parseDueDate(input.due);
  if (due === "invalid") return { error: "due must be a calendar date (YYYY-MM-DD)." };
  const description = (input.description ?? "").trim().slice(0, DESCRIPTION_MAX);
  const checkInCrons = Array.isArray(input.checkIn)
    ? input.checkIn.slice(0, MAX_CHECK_IN_CRONS)
    : [];

  const committed = await deps.prisma.$transaction(async (tx) => {
    const goal = await tx.goal.create({
      data: {
        spaceId: scope.spaceId,
        userId: scope.userId,
        botId: scope.botId,
        title,
        description,
        due,
        checkInCrons,
      },
    });
    // The Goal log: a Thread with this Goal's id and no bot/group/external conversation.
    await tx.thread.create({
      data: { spaceId: scope.spaceId, userId: scope.userId, goalId: goal.id },
    });

    const conversation = await tx.thread.findUnique({ where: { botId: scope.botId } });
    const proposedTasks = tasks.map((taskTitle) => ({ title: taskTitle }));
    let askMessageId: string | undefined;
    let notify: NotifyTarget = null;
    if (conversation) {
      const posted = await postProposalAsk(tx, {
        spaceId: scope.spaceId,
        botId: scope.botId,
        threadId: conversation.id,
        runId: scope.runId,
        goalTitle: goal.title,
        reason: "First plan",
        tasks: proposedTasks,
      });
      askMessageId = posted.message.id;
      notify = { threadId: posted.event.threadId, seq: posted.event.seq };
    }
    await tx.goalProposal.create({
      data: {
        goalId: goal.id,
        reason: "First plan",
        tasks: proposedTasks,
        status: "open",
        askMessageId,
      },
    });

    const repos = createGoalRepos(tx as unknown as PrismaClient);
    const mapped = await repos.getGoal(goal.id);
    return { goal: mapped!, notify };
  });

  await notifyIfNeeded(deps, committed.notify);
  return { goal: committed.goal };
}

/** `get`: one Goal with its plan and open Proposal, scoped to this Muse. */
export async function getGoalFromTool(
  deps: GoalToolDeps,
  scope: Pick<GoalToolScope, "botId">,
  input: { goalId: string },
): Promise<{ goal: Goal } | { error: string }> {
  const goalId = (input.goalId ?? "").trim();
  if (!goalId) return { error: "goalId is required." };
  const repos = createGoalRepos(deps.prisma);
  const goal = await repos.getGoal(goalId);
  if (!goal || goal.botId !== scope.botId) return { error: "Goal not found." };
  return { goal };
}

/** `list`: this Muse's active and paused Goals. */
export async function listGoalsFromTool(
  deps: GoalToolDeps,
  scope: Pick<GoalToolScope, "botId">,
): Promise<{ goals: Goal[] }> {
  const repos = createGoalRepos(deps.prisma);
  const goals = await repos.listGoals(scope.botId);
  return { goals };
}

/**
 * `update_task`: progress only, never the plan's shape. Marking a Task `blocked` with a
 * note that needs the person opens a blocked_task Ask in the Conversation.
 */
export async function updateGoalTaskFromTool(
  deps: GoalToolDeps,
  scope: GoalToolScope,
  input: { goalId: string; taskId: string; status: string; note?: string },
): Promise<{ goal: Goal } | { error: string }> {
  const goalId = (input.goalId ?? "").trim();
  const taskId = (input.taskId ?? "").trim();
  if (!goalId || !taskId) return { error: "goalId and taskId are required." };
  const statusResult = GoalTaskStatusSchema.safeParse(input.status);
  if (!statusResult.success) {
    return { error: "status must be pending, in_progress, done, blocked, or skipped." };
  }
  const status: GoalTaskStatus = statusResult.data;

  const committed = await deps.prisma.$transaction(async (tx) => {
    const goal = await tx.goal.findFirst({ where: { id: goalId, botId: scope.botId } });
    if (!goal) return { error: "Goal not found." } as const;
    const task = await tx.goalTask.findFirst({ where: { id: taskId, goalId: goal.id } });
    if (!task) return { error: "Task not found." } as const;

    const note = input.note !== undefined ? input.note.trim().slice(0, NOTE_MAX) : task.note;
    const wasBlocked = task.status === "blocked";
    await tx.goalTask.update({ where: { id: task.id }, data: { status, note } });

    let notify: NotifyTarget = null;
    if (status === "blocked" && !wasBlocked && note) {
      const conversation = await tx.thread.findUnique({ where: { botId: scope.botId } });
      if (conversation) {
        const posted = await postBlockedTaskAsk(tx, {
          spaceId: scope.spaceId,
          botId: scope.botId,
          threadId: conversation.id,
          runId: scope.runId,
          note,
          taskId: task.id,
        });
        notify = { threadId: posted.event.threadId, seq: posted.event.seq };
      }
    }

    const repos = createGoalRepos(tx as unknown as PrismaClient);
    const mapped = await repos.getGoal(goal.id);
    return { goal: mapped!, notify };
  });

  if ("error" in committed) return committed;
  await notifyIfNeeded(deps, committed.notify);
  return { goal: committed.goal };
}

/**
 * `propose`: a full revised plan. Withdraws any previous open Proposal on this Goal (there
 * is always at most one) and opens a new plan-change Ask in the Conversation.
 */
export async function proposeGoalPlanFromTool(
  deps: GoalToolDeps,
  scope: GoalToolScope,
  input: { goalId: string; reason: string; tasks: ProposedTaskInput[] },
): Promise<{ goal: Goal } | { error: string }> {
  const goalId = (input.goalId ?? "").trim();
  if (!goalId) return { error: "goalId is required." };
  const reason = (input.reason ?? "").trim();
  if (!reason) return { error: "reason is required." };
  const parsedTasks = GoalProposalTaskSchema.array()
    .min(1)
    .max(MAX_PROPOSAL_TASKS)
    .safeParse(input.tasks);
  if (!parsedTasks.success) {
    return { error: "tasks must be a non-empty list of {title, keepTaskId?}." };
  }

  const committed = await deps.prisma.$transaction(async (tx) => {
    const goal = await tx.goal.findFirst({ where: { id: goalId, botId: scope.botId } });
    if (!goal) return { error: "Goal not found." } as const;

    const withdrawnNotify = await withdrawOpenProposal(tx, goal);

    const conversation = await tx.thread.findUnique({ where: { botId: scope.botId } });
    let askMessageId: string | undefined;
    let notify = withdrawnNotify;
    if (conversation) {
      const posted = await postProposalAsk(tx, {
        spaceId: scope.spaceId,
        botId: scope.botId,
        threadId: conversation.id,
        runId: scope.runId,
        goalTitle: goal.title,
        reason,
        tasks: parsedTasks.data,
      });
      askMessageId = posted.message.id;
      // The new Ask supersedes the withdrawn one as the thread event worth a realtime nudge.
      notify = { threadId: posted.event.threadId, seq: posted.event.seq };
    }

    await tx.goalProposal.create({
      data: {
        goalId: goal.id,
        reason,
        tasks: parsedTasks.data,
        status: "open",
        askMessageId,
      },
    });

    const repos = createGoalRepos(tx as unknown as PrismaClient);
    const mapped = await repos.getGoal(goal.id);
    return { goal: mapped!, notify };
  });

  if ("error" in committed) return committed;
  await notifyIfNeeded(deps, committed.notify);
  return { goal: committed.goal };
}
