import { acceptGoalProposal, dismissGoalProposal } from "@aiden/adapters";
import type { Actor, Goal, GoalStatus, ThreadMessagePage } from "@aiden/contracts";
import {
  createGoalRepos,
  createRepos,
  IsolationError,
  type PrismaClient,
  type ThreadEvents,
} from "@aiden/db";
import { ORPCError } from "@orpc/server";
import { loadMessagePage } from "./thread-message-pages.js";

// B6 · Goal RPCs (docs/muse/PLAN.md). Real goals.list/get/update/acceptProposal/
// dismissProposal/log, replacing the "goals" part of muse-preview.ts. Every route is
// authorized the same way every other bot-scoped route is: goal -> its bot -> the
// actor's own Space/user (createRepos(prisma).getBot throws IsolationError otherwise).
// acceptProposal/dismissProposal call the same goal-proposals.ts functions `asks.answer`
// (muse-asks.ts) uses for a Proposal Ask answered from "Waiting on you" — one apply
// path, whichever screen answers it.

const GOAL_LOG_PAGE_SIZE = 100;

export interface GoalsDeps {
  prisma: PrismaClient;
  events: ThreadEvents;
}

/** The Goal's own bot must belong to the actor's space and user, like every bot-scoped route. */
async function requireOwnGoal(deps: GoalsDeps, actor: Actor, goalId: string): Promise<Goal> {
  const goal = await createGoalRepos(deps.prisma).getGoal(goalId);
  if (!goal) throw new IsolationError();
  await createRepos(deps.prisma).getBot(actor, goal.botId);
  return goal;
}

/** A Proposal's own Goal's bot must belong to the actor, same rule as `requireOwnGoal`. */
async function requireOwnProposal(
  deps: GoalsDeps,
  actor: Actor,
  proposalId: string,
): Promise<void> {
  const proposal = await deps.prisma.goalProposal.findFirst({
    where: { id: proposalId },
    select: { goalId: true },
  });
  if (!proposal) throw new IsolationError();
  const goal = await deps.prisma.goal.findFirst({
    where: { id: proposal.goalId },
    select: { botId: true },
  });
  if (!goal) throw new IsolationError();
  await createRepos(deps.prisma).getBot(actor, goal.botId);
}

export async function listGoals(
  deps: GoalsDeps,
  actor: Actor,
  input: { botId: string; includeClosed?: boolean },
): Promise<Goal[]> {
  await createRepos(deps.prisma).getBot(actor, input.botId);
  return createGoalRepos(deps.prisma).listGoals(input.botId, {
    includeClosed: input.includeClosed,
  });
}

export async function getGoal(deps: GoalsDeps, actor: Actor, goalId: string): Promise<Goal> {
  return requireOwnGoal(deps, actor, goalId);
}

export async function updateGoal(
  deps: GoalsDeps,
  actor: Actor,
  input: {
    goalId: string;
    status?: Exclude<GoalStatus, "done">;
    checkInCrons?: string[];
    timezone?: string;
  },
): Promise<Goal> {
  await requireOwnGoal(deps, actor, input.goalId);
  return createGoalRepos(deps.prisma).updateGoal(input.goalId, {
    status: input.status,
    checkInCrons: input.checkInCrons,
    timezone: input.timezone,
  });
}

export async function acceptProposal(
  deps: GoalsDeps,
  actor: Actor,
  proposalId: string,
): Promise<Goal> {
  await requireOwnProposal(deps, actor, proposalId);
  const goal = await acceptGoalProposal(deps, proposalId);
  if (!goal) throw new ORPCError("CONFLICT", { message: "This proposal is no longer open" });
  return goal;
}

export async function dismissProposal(
  deps: GoalsDeps,
  actor: Actor,
  proposalId: string,
): Promise<Goal> {
  await requireOwnProposal(deps, actor, proposalId);
  const goal = await dismissGoalProposal(deps, proposalId);
  if (!goal) throw new ORPCError("CONFLICT", { message: "This proposal is no longer open" });
  return goal;
}

/** The Goal log: read-only paging over the Goal's own Thread, same shape as `threads.messages`. */
export async function getGoalLog(
  deps: GoalsDeps,
  actor: Actor,
  input: { goalId: string; before?: number },
): Promise<ThreadMessagePage> {
  await requireOwnGoal(deps, actor, input.goalId);
  const thread = await deps.prisma.thread.findUnique({
    where: { goalId: input.goalId },
    select: { id: true },
  });
  if (!thread) throw new IsolationError();
  return loadMessagePage(deps.prisma, thread.id, input.before, GOAL_LOG_PAGE_SIZE);
}
