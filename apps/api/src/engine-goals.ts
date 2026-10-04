// `goals.*` and the plan-change Asks for Muses whose Goals the engine owns
// (docs/adr/0005-proactive-work-is-scheduled-helper-runs.md). A Goal is an engine objective
// under the Muse's Super Chat; its check-in schedule is the scheduled task that advances it and
// its log is that task's Helper runs. Nova keeps no Goal rows for these Muses.
import {
  decideOmnigentObjectiveProposal,
  getOmnigentObjective,
  getOmnigentScheduledTask,
  isSessionNotFoundError,
  listOmnigentObjectiveLog,
  listOmnigentObjectives,
  listOmnigentScheduledTasks,
  OmnigentApiError,
  type OmnigentClientConfig,
  type OmnigentObjective,
  type OmnigentScheduledTask,
  patchOmnigentObjective,
  patchOmnigentScheduledTask,
  redactThreadMessages,
  updateOmnigentObjectiveTask,
} from "@aiden/adapters";
import type {
  Actor,
  Ask,
  Goal,
  GoalProposal,
  GoalStatus,
  GoalTask,
  ThreadMessage,
  ThreadMessagePage,
} from "@aiden/contracts";
import type { PrismaClient } from "@aiden/db";
import { ORPCError } from "@orpc/server";
import { cronFromRrule, rruleFromCron } from "./goal-cadence.js";

const LOG_LIMIT = 50;

export interface EngineGoalsDeps {
  prisma: PrismaClient;
}

interface Target {
  client: OmnigentClientConfig;
  email: string;
  botId: string;
}

/** Goals live on the engine: without one configured there is nothing to read or change. */
export function requireGoalsEngine(client: OmnigentClientConfig | undefined): OmnigentClientConfig {
  if (!client) throw new ORPCError("SERVICE_UNAVAILABLE", { message: "Goals need the engine" });
  return client;
}

const iso = (epochSeconds: number) => new Date(epochSeconds * 1000).toISOString();

/** An engine objective's status as the Goals screen knows it. */
const GOAL_STATUS: Record<OmnigentObjective["status"], GoalStatus> = {
  active: "active",
  paused: "paused",
  done: "done",
  archived: "cancelled",
};

/** The engine answers 404 for a missing objective and for another person's. */
const isNotFound = isSessionNotFoundError;

async function email(deps: EngineGoalsDeps, actor: Actor): Promise<string> {
  const user = await deps.prisma.user.findUnique({
    where: { id: actor.userId },
    select: { email: true },
  });
  if (!user) throw new ORPCError("NOT_FOUND", { message: "Person not found" });
  return user.email;
}

/** The Muse's Super Chat id; the bot must be the actor's own. `null` while it has no Conversation. */
async function superChatOf(
  deps: EngineGoalsDeps,
  actor: Actor,
  botId: string,
): Promise<string | null> {
  const [bot, session] = await Promise.all([
    deps.prisma.bot.findFirst({
      where: { id: botId, spaceId: actor.spaceId, userId: actor.userId },
      select: { id: true },
    }),
    deps.prisma.omnigentSession.findUnique({
      where: { botId },
      select: { omnigentSessionId: true },
    }),
  ]);
  if (!bot) throw new ORPCError("NOT_FOUND", { message: "Muse not found" });
  return session?.omnigentSessionId ?? null;
}

/** An objective of one of the actor's own Muses, with that Muse's id; anything else is a 404. */
async function ownObjective(
  deps: EngineGoalsDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  goalId: string,
): Promise<{ target: Target; objective: OmnigentObjective }> {
  const address = await email(deps, actor);
  const objective = await getOmnigentObjective(client, address, goalId).catch((error) => {
    if (isNotFound(error)) return null;
    throw error;
  });
  const session = objective
    ? await deps.prisma.omnigentSession.findFirst({
        where: {
          omnigentSessionId: objective.parent_session_id,
          bot: { spaceId: actor.spaceId, userId: actor.userId },
        },
        select: { botId: true },
      })
    : null;
  if (!objective || !session) throw new ORPCError("NOT_FOUND", { message: "Goal not found" });
  return { target: { client, email: address, botId: session.botId }, objective };
}

/** A due date as the calendar day the Goals screen shows (YYYY-MM-DD). */
const dueDay = (due: string | null): string | null => (due ? due.slice(0, 10) : null);

function toGoal(
  botId: string,
  objective: OmnigentObjective,
  cadence: OmnigentScheduledTask | null | undefined,
): Goal {
  const updatedAt = iso(objective.updated_at ?? objective.created_at);
  const tasks: GoalTask[] = objective.plan.map((task, idx) => ({
    id: task.id,
    goalId: objective.id,
    idx,
    title: task.title,
    status: task.status,
    note: task.note ?? "",
    updatedAt,
  }));
  const proposal = objective.open_proposal;
  const openProposal: GoalProposal | null =
    proposal && proposal.plan.length > 0
      ? {
          id: proposal.id,
          goalId: objective.id,
          reason: proposal.reason,
          tasks: proposal.plan.map((item) => ({
            title: item.title,
            ...(item.id ? { keepTaskId: item.id } : {}),
          })),
          status: "open",
          createdAt: iso(proposal.created_at),
        }
      : null;
  const cron = cadence ? cronFromRrule(cadence.rrule) : null;
  return {
    id: objective.id,
    botId,
    title: objective.title,
    description: objective.description,
    status: GOAL_STATUS[objective.status],
    due: dueDay(objective.due),
    checkInCrons: cron ? [cron] : [],
    timezone: cadence?.timezone ?? "UTC",
    tasks,
    openProposal,
    lastWorkedAt: cadence?.last_run_at ? iso(cadence.last_run_at) : null,
    nextWorkAt:
      objective.status === "active" && cadence?.next_run_at && cadence.state === "active"
        ? cadence.next_run_at
        : null,
    createdAt: iso(objective.created_at),
    updatedAt,
  };
}

async function cadenceOf(
  target: Target,
  objective: OmnigentObjective,
): Promise<OmnigentScheduledTask | null> {
  if (!objective.scheduled_task_id) return null;
  return getOmnigentScheduledTask(target.client, target.email, objective.scheduled_task_id).catch(
    (error) => {
      if (isNotFound(error)) return null;
      throw error;
    },
  );
}

export async function engineListGoals(
  deps: EngineGoalsDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  input: { botId: string; includeClosed?: boolean },
): Promise<Goal[]> {
  const sessionId = await superChatOf(deps, actor, input.botId);
  if (!sessionId) return [];
  const address = await email(deps, actor);
  const [objectives, tasks] = await Promise.all([
    listOmnigentObjectives(client, address, sessionId),
    listOmnigentScheduledTasks(client, address, sessionId),
  ]);
  const cadences = new Map(tasks.map((task) => [task.id, task]));
  return objectives
    .filter(
      (objective) =>
        input.includeClosed || objective.status === "active" || objective.status === "paused",
    )
    .sort((a, b) => (b.updated_at ?? b.created_at) - (a.updated_at ?? a.created_at))
    .map((objective) =>
      toGoal(input.botId, objective, cadences.get(objective.scheduled_task_id ?? "")),
    );
}

export async function engineGetGoal(
  deps: EngineGoalsDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  goalId: string,
): Promise<Goal> {
  const { target, objective } = await ownObjective(deps, client, actor, goalId);
  return toGoal(target.botId, objective, await cadenceOf(target, objective));
}

const ENGINE_STATUS = {
  active: "active",
  paused: "paused",
  cancelled: "archived",
} as const;

export async function engineUpdateGoal(
  deps: EngineGoalsDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  input: { goalId: string; status?: "active" | "paused" | "cancelled"; checkInCrons?: string[] },
): Promise<Goal> {
  const { target, objective: before } = await ownObjective(deps, client, actor, input.goalId);
  let objective = before;
  if (input.checkInCrons !== undefined) {
    const [cron] = input.checkInCrons;
    const rrule = input.checkInCrons.length === 1 && cron ? rruleFromCron(cron) : null;
    if (!before.scheduled_task_id || !rrule) {
      throw new ORPCError("BAD_REQUEST", {
        message: "Pick an hourly, daily, weekly or monthly check-in.",
      });
    }
    await patchOmnigentScheduledTask(client, target.email, before.scheduled_task_id, { rrule });
  }
  if (input.status) {
    objective = await patchOmnigentObjective(client, target.email, input.goalId, {
      status: ENGINE_STATUS[input.status],
    });
  }
  return toGoal(target.botId, objective, await cadenceOf(target, objective));
}

async function applyDecision(
  target: Target,
  input: { goalId: string; proposalId: string },
  decision: "accept" | "dismiss",
): Promise<Goal> {
  const objective = await decideOmnigentObjectiveProposal(
    target.client,
    target.email,
    input.goalId,
    input.proposalId,
    decision,
  ).catch((error) => {
    if (error instanceof OmnigentApiError && error.code === "conflict") {
      throw new ORPCError("CONFLICT", { message: "This proposal is no longer open" });
    }
    throw error;
  });
  return toGoal(target.botId, objective, await cadenceOf(target, objective));
}

async function decide(
  deps: EngineGoalsDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  input: { goalId: string; proposalId: string },
  decision: "accept" | "dismiss",
): Promise<Goal> {
  const { target } = await ownObjective(deps, client, actor, input.goalId);
  return applyDecision(target, input, decision);
}

export const engineAcceptProposal = (
  deps: EngineGoalsDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  input: { goalId: string; proposalId: string },
) => decide(deps, client, actor, input, "accept");

export const engineDismissProposal = (
  deps: EngineGoalsDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  input: { goalId: string; proposalId: string },
) => decide(deps, client, actor, input, "dismiss");

/** The Goal log: the objective's finished Helper runs, oldest first, each Result as a message. */
export async function engineGoalLog(
  deps: EngineGoalsDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  goalId: string,
): Promise<ThreadMessagePage> {
  const { target } = await ownObjective(deps, client, actor, goalId);
  const entries = await listOmnigentObjectiveLog(client, target.email, goalId, LOG_LIMIT);
  const messages: ThreadMessage[] = entries
    .filter((entry) => entry.status === "succeeded" && entry.result?.trim())
    .reverse()
    .map((entry, seq) => ({
      id: entry.run_id,
      threadId: goalId,
      seq,
      role: "bot" as const,
      blocks: [{ kind: "text" as const, text: entry.result as string }],
      createdAt: iso(entry.finished_at ?? entry.fired_at ?? entry.scheduled_at),
    }));
  return {
    threadId: goalId,
    messages: redactThreadMessages(messages, client.secrets ?? []),
    olderCursor: null,
  };
}

/** Open plan changes and blocked Tasks of the Muse's Goals, as Asks. A Proposal Ask is named by
 * its proposal id and a blocked-Task Ask by its task id; both carry the Goal id as `runId`, which
 * is how `engineAnswerAsk` finds the objective again. */
export async function engineGoalAsks(
  deps: EngineGoalsDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  botId: string,
): Promise<Ask[]> {
  const sessionId = await superChatOf(deps, actor, botId);
  if (!sessionId) return [];
  const objectives = await listOmnigentObjectives(client, await email(deps, actor), sessionId);
  const asks: Ask[] = [];
  for (const objective of objectives) {
    if (objective.status !== "active") continue;
    const proposal = objective.open_proposal;
    if (proposal) {
      const first = objective.plan.length === 0;
      const steps = proposal.plan.map((item, index) => `${index + 1}. ${item.title}`);
      asks.push({
        id: proposal.id,
        runId: objective.id,
        kind: "proposal",
        goalId: objective.id,
        goalTitle: objective.title,
        text: first
          ? `Here's my plan for "${objective.title}"`
          : `Change the plan for "${objective.title}"?`,
        detail: (first ? steps : [proposal.reason, ...steps]).join("\n"),
        choices: first
          ? [
              { id: "accept", label: "Start this plan" },
              { id: "dismiss", label: "Not now" },
            ]
          : [
              { id: "accept", label: "Use the new plan" },
              { id: "dismiss", label: "Keep current" },
            ],
        input: null,
        createdAt: iso(proposal.created_at),
      });
    }
    for (const task of objective.plan) {
      if (task.status !== "blocked") continue;
      asks.push({
        id: task.id,
        runId: objective.id,
        kind: "blocked_task",
        goalId: objective.id,
        goalTitle: objective.title,
        text: task.note?.trim() || task.title,
        choices: [],
        input: "text",
        createdAt: iso(objective.updated_at ?? objective.created_at),
      });
    }
  }
  return asks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Answers a Goal Ask: a Proposal is accepted or dismissed, a blocked Task gets the answer in its
 * note and goes back to pending. `null` when `askId` is neither (so the caller can say so). */
export async function engineAnswerAsk(
  deps: EngineGoalsDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  input: { askId: string; runId: string; answer: string },
): Promise<{ ok: true } | null> {
  const own = await ownObjective(deps, client, actor, input.runId).catch((error) => {
    if (error instanceof ORPCError && error.code === "NOT_FOUND") return null;
    throw error;
  });
  if (!own) return null;
  const { target, objective } = own;
  if (input.askId === objective.open_proposal?.id) {
    if (input.answer !== "accept" && input.answer !== "dismiss") {
      throw new ORPCError("BAD_REQUEST", { message: "Answer a Proposal accept or dismiss." });
    }
    await applyDecision(target, { goalId: input.runId, proposalId: input.askId }, input.answer);
    return { ok: true as const };
  }
  const task = objective.plan.find((item) => item.id === input.askId && item.status === "blocked");
  if (!task) return null;
  const note = task.note ? `${task.note}\n\nAnswer: ${input.answer}` : `Answer: ${input.answer}`;
  await updateOmnigentObjectiveTask(client, target.email, input.runId, task.id, {
    status: "pending",
    note: note.slice(0, 2000),
  });
  return { ok: true as const };
}
