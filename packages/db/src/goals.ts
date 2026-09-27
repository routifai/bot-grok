import {
  type Goal,
  type GoalProposal,
  type GoalProposalTask,
  GoalProposalTaskSchema,
  type GoalStatus,
  type GoalTask,
} from "@aiden/contracts";
import type { Prisma, PrismaClient } from "./client.js";

// Repository for Goal / GoalTask / GoalProposal (CONTEXT.md; docs/muse/PLAN.md B3).
// Later packages (B4 the `goals` tool, B5 goals-context, B6 the goals.* RPCs) build on
// these helpers instead of querying Prisma directly.

const GOAL_PROPOSAL_TASKS_JSON_SCHEMA = GoalProposalTaskSchema.array().min(1);

/** Calendar date only (decision: `due` has date semantics, not a time of day). */
function formatDueDate(due: Date | null): string | null {
  if (!due) return null;
  return due.toISOString().slice(0, 10);
}

/** Parse `GoalProposal.tasks` back to the contract shape; DB rows are our own writes. */
function parseProposalTasks(tasks: unknown): GoalProposalTask[] {
  return GOAL_PROPOSAL_TASKS_JSON_SCHEMA.parse(tasks);
}

interface GoalTaskRow {
  id: string;
  goalId: string;
  idx: number;
  title: string;
  status: string;
  note: string;
  updatedAt: Date;
}

interface GoalProposalRow {
  id: string;
  goalId: string;
  reason: string;
  tasks: unknown;
  status: string;
  createdAt: Date;
}

interface GoalRow {
  id: string;
  botId: string;
  title: string;
  description: string;
  status: string;
  due: Date | null;
  checkInCrons: string[];
  timezone: string;
  lastWorkedAt: Date | null;
  nextWorkAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  tasks: GoalTaskRow[];
  /** The single open proposal, if any (queries below filter to at most one). */
  proposals: GoalProposalRow[];
}

export function mapGoalTask(task: GoalTaskRow): GoalTask {
  return {
    id: task.id,
    goalId: task.goalId,
    idx: task.idx,
    title: task.title,
    status: task.status as GoalTask["status"],
    note: task.note,
    updatedAt: task.updatedAt.toISOString(),
  };
}

export function mapGoalProposal(proposal: GoalProposalRow): GoalProposal {
  return {
    id: proposal.id,
    goalId: proposal.goalId,
    reason: proposal.reason,
    tasks: parseProposalTasks(proposal.tasks),
    status: proposal.status as GoalProposal["status"],
    createdAt: proposal.createdAt.toISOString(),
  };
}

/** Map a Goal row (with its tasks and open proposal loaded) to the contract shape. */
export function mapGoal(goal: GoalRow): Goal {
  const openProposal = goal.proposals.find((proposal) => proposal.status === "open") ?? null;
  return {
    id: goal.id,
    botId: goal.botId,
    title: goal.title,
    description: goal.description,
    status: goal.status as Goal["status"],
    due: formatDueDate(goal.due),
    checkInCrons: goal.checkInCrons,
    timezone: goal.timezone,
    tasks: goal.tasks.map(mapGoalTask),
    openProposal: openProposal ? mapGoalProposal(openProposal) : null,
    lastWorkedAt: goal.lastWorkedAt?.toISOString() ?? null,
    nextWorkAt: goal.nextWorkAt?.toISOString() ?? null,
    createdAt: goal.createdAt.toISOString(),
    updatedAt: goal.updatedAt.toISOString(),
  };
}

const GOAL_INCLUDE = {
  tasks: { orderBy: { idx: "asc" as const } },
  // At most one open proposal ever exists per goal (partial unique index).
  proposals: { where: { status: "open" }, take: 1 },
};

export function createGoalRepos(prisma: PrismaClient) {
  return {
    /** Goals for one Muse (bot), newest work due first; closed goals excluded by default. */
    async listGoals(botId: string, options: { includeClosed?: boolean } = {}): Promise<Goal[]> {
      const goals = await prisma.goal.findMany({
        where: {
          botId,
          ...(options.includeClosed ? {} : { status: { in: ["active", "paused"] } }),
        },
        include: GOAL_INCLUDE,
        orderBy: [{ nextWorkAt: "asc" }, { createdAt: "asc" }],
      });
      return goals.map(mapGoal);
    },

    /** One Goal with its plan (ordered) and open proposal, or null if it doesn't exist. */
    async getGoal(goalId: string): Promise<Goal | null> {
      const goal = await prisma.goal.findUnique({
        where: { id: goalId },
        include: GOAL_INCLUDE,
      });
      return goal ? mapGoal(goal) : null;
    },

    /**
     * `goals.update` (B6): status (active/paused/cancelled — never `done`, which the
     * Muse alone reaches by finishing every Task) and/or the check-in schedule. Only
     * the given fields change; omitted ones are left as saved. The caller authorizes
     * the Goal before calling this (see `requireOwnGoal` in apps/api/src/goals.ts).
     */
    async updateGoal(
      goalId: string,
      patch: { status?: GoalStatus; checkInCrons?: string[]; timezone?: string },
    ): Promise<Goal> {
      const data: Prisma.GoalUpdateInput = {};
      if (patch.status !== undefined) data.status = patch.status;
      if (patch.checkInCrons !== undefined) data.checkInCrons = patch.checkInCrons;
      if (patch.timezone !== undefined) data.timezone = patch.timezone;
      const goal = await prisma.goal.update({
        where: { id: goalId },
        data,
        include: GOAL_INCLUDE,
      });
      return mapGoal(goal);
    },
  };
}
