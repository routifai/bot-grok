// `automations.*`: the person's scheduled prompts, run by the engine's scheduled tasks
// (`/v1/scheduled-tasks`). Each is a scheduled Helper task parented on the Muse's Super Chat and
// marked `automation`, so the engine fires it, owns its schedule and records its runs; Superchat keeps
// no rows. Every call is owner-scoped: the Muse must be the actor's own, and only tasks bound to
// its Super Chat with this marker are listed, changed, run or removed.
import {
  createOmnigentScheduledTask,
  deleteOmnigentScheduledTask,
  listOmnigentScheduledTasks,
  type OmnigentClientConfig,
  type OmnigentScheduledTask,
  patchOmnigentScheduledTask,
  runOmnigentScheduledTask,
} from "@superchat/adapters";
import type { Actor, Automation, AutomationSchedule } from "@superchat/contracts";
import type { PrismaClient } from "@superchat/db";
import { ORPCError } from "@orpc/server";
import { rruleToSchedule, scheduleToRrule } from "./schedule.js";

/** The engine's marker for an automation's scheduled task. */
export const AUTOMATION_KIND = "automation";
/** The Helper type an automation's runs use. */
const AUTOMATION_HELPER = "worker";

export interface EngineAutomationsDeps {
  prisma: PrismaClient;
}

interface Target {
  client: OmnigentClientConfig;
  email: string;
  sessionId: string;
}

const iso = (epochSeconds: number | null | undefined) =>
  epochSeconds ? new Date(epochSeconds * 1000).toISOString() : null;

/** The Muse's Super Chat; the bot must be the actor's own. `null` while it has no Conversation. */
async function resolve(
  deps: EngineAutomationsDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  botId: string,
): Promise<Target | null> {
  const [bot, user, session] = await Promise.all([
    deps.prisma.bot.findFirst({
      where: { id: botId, spaceId: actor.spaceId, userId: actor.userId },
      select: { id: true },
    }),
    deps.prisma.user.findUnique({ where: { id: actor.userId }, select: { email: true } }),
    deps.prisma.omnigentSession.findUnique({
      where: { botId },
      select: { omnigentSessionId: true },
    }),
  ]);
  if (!bot || !user) throw new ORPCError("NOT_FOUND", { message: "Muse not found" });
  return session ? { client, email: user.email, sessionId: session.omnigentSessionId } : null;
}

async function tasksOf(target: Target): Promise<OmnigentScheduledTask[]> {
  const tasks = await listOmnigentScheduledTasks(target.client, target.email, target.sessionId);
  return tasks.filter((task) => task.kind === AUTOMATION_KIND);
}

export function toAutomation(task: OmnigentScheduledTask): Automation {
  const enabled = task.state === "active";
  return {
    id: task.id,
    name: task.name,
    prompt: task.prompt,
    rrule: task.rrule,
    schedule: rruleToSchedule(task.rrule),
    timezone: task.timezone,
    enabled,
    nextRunAt: enabled ? (task.next_run_at ?? null) : null,
    lastRunAt: iso(task.last_run_at),
    lastRunStatus: task.last_run_status ?? null,
    model: task.model_override ?? null,
    createdAt: iso(task.created_at) ?? new Date(0).toISOString(),
  };
}

async function owned(target: Target, id: string): Promise<OmnigentScheduledTask> {
  const task = (await tasksOf(target)).find((candidate) => candidate.id === id);
  if (!task) throw new ORPCError("NOT_FOUND", { message: "Automation not found" });
  return task;
}

async function needTarget(
  deps: EngineAutomationsDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  botId: string,
): Promise<Target> {
  const target = await resolve(deps, client, actor, botId);
  if (!target) throw new ORPCError("NOT_FOUND", { message: "This Muse has no Conversation yet" });
  return target;
}

export async function engineListAutomations(
  deps: EngineAutomationsDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  botId: string,
): Promise<Automation[]> {
  const target = await resolve(deps, client, actor, botId);
  return target ? (await tasksOf(target)).map(toAutomation) : [];
}

export async function engineCreateAutomation(
  deps: EngineAutomationsDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  input: {
    botId: string;
    name: string;
    prompt: string;
    schedule: AutomationSchedule;
    timezone?: string;
    model?: string;
  },
): Promise<Automation> {
  const target = await needTarget(deps, client, actor, input.botId);
  const task = await createOmnigentScheduledTask(client, target.email, {
    name: input.name,
    prompt: input.prompt,
    rrule: scheduleToRrule(input.schedule),
    parentSessionId: target.sessionId,
    agentType: AUTOMATION_HELPER,
    kind: AUTOMATION_KIND,
    ...(input.timezone ? { timezone: input.timezone } : {}),
    ...(input.model ? { modelOverride: input.model } : {}),
  });
  return toAutomation(task);
}

export async function engineUpdateAutomation(
  deps: EngineAutomationsDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  input: {
    botId: string;
    id: string;
    enabled?: boolean;
    name?: string;
    prompt?: string;
    schedule?: AutomationSchedule;
  },
): Promise<Automation> {
  const target = await needTarget(deps, client, actor, input.botId);
  await owned(target, input.id);
  const task = await patchOmnigentScheduledTask(client, target.email, input.id, {
    ...(input.enabled === undefined ? {} : { state: input.enabled ? "active" : "paused" }),
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
    ...(input.schedule === undefined ? {} : { rrule: scheduleToRrule(input.schedule) }),
  });
  return toAutomation(task);
}

export async function engineRunAutomation(
  deps: EngineAutomationsDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  input: { botId: string; id: string },
): Promise<{ ok: true }> {
  const target = await needTarget(deps, client, actor, input.botId);
  await owned(target, input.id);
  await runOmnigentScheduledTask(client, target.email, input.id);
  return { ok: true as const };
}

export async function engineRemoveAutomation(
  deps: EngineAutomationsDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  input: { botId: string; id: string },
): Promise<{ ok: true }> {
  const target = await needTarget(deps, client, actor, input.botId);
  await owned(target, input.id);
  await deleteOmnigentScheduledTask(client, target.email, input.id);
  return { ok: true as const };
}
