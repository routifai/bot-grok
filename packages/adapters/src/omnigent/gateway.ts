// Runs a Nova run on Omnigent instead of the built-in run executor, behind NOVA_ENGINE=omnigent
// (docs/omnigent-spike.md). Deliberately narrow for week 1: only a plain user message on a
// Muse's own private Conversation thread (never a routine, Goal-log, group thread, or messaging
// channel run) is eligible — everything else falls back to the existing engine untouched.
//
// This intentionally skips the full run-executor lease machinery (computer leases, takeover,
// heartbeats): those exist to coordinate sandboxed tool execution the Omnigent harness does not
// use here. It still claims the run with the same fence/lease columns and finishes through
// `ThreadEvents.finalizeRun` so the thread, task, and run rows land in the same state a normal
// turn would.
import { containsSecret, redactSecrets } from "@aiden/core";
import type { PrismaClient, ThreadEvents } from "@aiden/db";
import { getLogger } from "@aiden/logging";
import {
  createOmnigentSession,
  findOmnigentAgentIdByName,
  type OmnigentClientConfig,
  postOmnigentMessage,
  streamOmnigentSession,
  switchOmnigentAgent,
} from "./client.js";
import { agentNameForMuseHarness } from "./harnesses.js";

/** Upper bound on how long one turn may run on Omnigent before the gateway gives up. */
const TURN_TIMEOUT_MS = 5 * 60_000;
const LEASE_DURATION_MS = 5 * 60_000;

export interface OmnigentGatewayDeps {
  prisma: PrismaClient;
  events: ThreadEvents;
  client: OmnigentClientConfig;
  /** Secret values redacted from the assistant's reply before it is persisted. */
  secrets: string[];
  /** Built-in Omnigent agent bundle name Nova Conversation turns run on when a Muse hasn't
   * chosen its own harness (Bot.museHarness null) — resolved once at boot from
   * `OMNIGENT_AGENT_NAME` (./env.ts). */
  agentName: string;
}

/**
 * Attempts to run `runId` on Omnigent. Returns `false` when the run is not eligible for the
 * Omnigent path (caller should fall back to the normal executor) and `true` once this call has
 * taken ownership of finishing `run.continue` for it — including when the turn itself failed,
 * which is still reported through the normal `finalizeRun(outcome: "failed")` path.
 */
export async function runTurnOnOmnigent(
  deps: OmnigentGatewayDeps,
  runId: string,
  workerId: string,
): Promise<boolean> {
  const run = await deps.prisma.run.findUnique({ where: { id: runId } });
  if (run?.status !== "queued" || run.trigger !== "user") return false;

  const thread = await deps.prisma.thread.findUnique({
    where: { id: run.threadId },
    select: { botId: true, goalId: true },
  });
  if (!thread || thread.botId !== run.botId || thread.goalId) return false;

  const fence = run.leaseFence + 1;
  const leased = await deps.prisma.run.updateMany({
    where: { id: runId, status: "queued" },
    data: {
      status: "running",
      leaseOwner: workerId,
      leaseFence: fence,
      startedAt: new Date(),
      leaseExpiresAt: new Date(Date.now() + LEASE_DURATION_MS),
      error: null,
    },
  });
  // Lost the claim race to another worker invocation; it owns finishing this run.
  if (leased.count !== 1) return true;

  const attempt = await deps.prisma.attempt.create({
    data: { runId, fence, status: "running" },
  });

  try {
    const [user, task, bot] = await Promise.all([
      deps.prisma.user.findUniqueOrThrow({ where: { id: run.userId }, select: { email: true } }),
      deps.prisma.task.findUniqueOrThrow({ where: { id: run.taskId }, select: { prompt: true } }),
      deps.prisma.bot.findUniqueOrThrow({
        where: { id: run.botId },
        select: { museHarness: true },
      }),
    ]);
    const desiredAgentName = agentNameForMuseHarness(bot.museHarness, deps.agentName);

    const sessionId = await ensureOmnigentSession(deps, user.email, run, desiredAgentName);
    const text = await sendTurnAndAwaitReply(deps, user.email, sessionId, task.prompt);
    const redacted = redactSecrets(text, deps.secrets);
    if (containsSecret(redacted, deps.secrets)) {
      throw new Error("refusing to persist a secret in the thread");
    }

    const completed = await deps.events.finalizeRun({
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      runId,
      taskId: run.taskId,
      attemptId: attempt.id,
      leaseOwner: workerId,
      leaseFence: fence,
      outcome: "completed",
      blocks: redacted ? [{ kind: "text", text: redacted }] : [],
      markUnread: true,
    });
    if (!completed) {
      getLogger().error("omnigent gateway: finalizeRun(completed) did not apply", { runId });
    }
  } catch (error) {
    getLogger().error("omnigent gateway turn failed", error);
    await deps.events
      .finalizeRun({
        spaceId: run.spaceId,
        threadId: run.threadId,
        botId: run.botId,
        runId,
        taskId: run.taskId,
        attemptId: attempt.id,
        leaseOwner: workerId,
        leaseFence: fence,
        outcome: "failed",
        error: error instanceof Error ? error.message : String(error),
      })
      .catch((finalizeError) =>
        getLogger().error("omnigent gateway: finalizeRun(failed) also failed", finalizeError),
      );
  }
  return true;
}

/** Session labels Omnigent's context-provider hook and its own routing key off of. */
function sessionLabels(run: { userId: string; spaceId: string; botId: string }) {
  return {
    "nova.user": run.userId,
    "nova.space": run.spaceId,
    "nova.bot": run.botId,
    "nova.scope": "private",
  };
}

/**
 * One Omnigent session per Muse (bot), stored so every turn continues the same conversation.
 * When a session already exists but its recorded `agentName` no longer matches the bot's
 * resolved harness (`desiredAgentName`), switches it in place first — the session is idle
 * between turns, which is switch-agent's only precondition
 * (engine/omnigent/omnigent/server/routes/sessions/routes_core.py ~3580-3700).
 */
async function ensureOmnigentSession(
  deps: OmnigentGatewayDeps,
  email: string,
  run: { userId: string; spaceId: string; botId: string },
  desiredAgentName: string,
): Promise<string> {
  const existing = await deps.prisma.omnigentSession.findUnique({
    where: { botId: run.botId },
  });
  if (existing) {
    if (existing.agentName !== desiredAgentName) {
      await switchOmnigentSessionAgent(
        deps,
        email,
        run.botId,
        existing.omnigentSessionId,
        desiredAgentName,
      );
    }
    return existing.omnigentSessionId;
  }

  const agentId = await findOmnigentAgentIdByName(deps.client, email, desiredAgentName);
  if (!agentId) {
    throw new Error(`no Omnigent agent bundle named "${desiredAgentName}" is registered`);
  }
  const session = await createOmnigentSession(deps.client, email, {
    agentId,
    labels: sessionLabels(run),
    title: "Nova Conversation",
  });
  const saved = await deps.prisma.omnigentSession.upsert({
    where: { botId: run.botId },
    create: { botId: run.botId, omnigentSessionId: session.id, agentName: desiredAgentName },
    update: { omnigentSessionId: session.id, agentName: desiredAgentName },
  });
  return saved.omnigentSessionId;
}

/**
 * Rebinds an existing Omnigent session to `desiredAgentName` before this turn's message posts.
 * Never fails the turn: on any error (agent id lookup, switch-agent itself, e.g. the session
 * turned out to be busy or the target bundle failed to load) this logs and returns, leaving the
 * DB record untouched so the next turn simply retries the switch against the still-current
 * agent.
 */
async function switchOmnigentSessionAgent(
  deps: OmnigentGatewayDeps,
  email: string,
  botId: string,
  omnigentSessionId: string,
  desiredAgentName: string,
): Promise<void> {
  try {
    const agentId = await findOmnigentAgentIdByName(deps.client, email, desiredAgentName);
    if (!agentId) {
      throw new Error(`no Omnigent agent bundle named "${desiredAgentName}" is registered`);
    }
    await switchOmnigentAgent(deps.client, email, omnigentSessionId, agentId);
    await deps.prisma.omnigentSession.update({
      where: { botId },
      data: { agentName: desiredAgentName },
    });
  } catch (error) {
    getLogger().error("omnigent gateway: switch-agent failed, continuing on current agent", error);
  }
}

/**
 * Posts the turn's message, then reads the live stream until `response.completed`, returning
 * the assistant's text. The GET stream request is started (its body opened) before the POST so
 * a fast reply cannot race ahead of the listener — see engine/omnigent/omnigent/server/API.md's
 * "Reconnect Contract" note on opening the stream first.
 */
async function sendTurnAndAwaitReply(
  deps: OmnigentGatewayDeps,
  email: string,
  sessionId: string,
  turnInput: string,
): Promise<string> {
  const signal = AbortSignal.timeout(TURN_TIMEOUT_MS);
  const iterator = streamOmnigentSession(deps.client, email, sessionId, signal)[
    Symbol.asyncIterator
  ]();
  const first = iterator.next();
  await postOmnigentMessage(deps.client, email, sessionId, turnInput);

  let step = await first;
  while (!step.done) {
    const event = step.value;
    if (event.type === "response.completed") {
      const response = event.response as { output?: Array<Record<string, unknown>> } | undefined;
      return extractAssistantText(response?.output ?? []);
    }
    if (event.type === "response.failed" || event.type === "response.error") {
      const message =
        (event.error as { message?: string } | undefined)?.message ??
        (event as { message?: string }).message ??
        "Omnigent turn failed";
      throw new Error(message);
    }
    step = await iterator.next();
  }
  throw new Error("Omnigent session stream ended before response.completed");
}

/** `response.output` items → assistant message text (OpenAI Responses-style content parts). */
function extractAssistantText(output: Array<Record<string, unknown>>): string {
  const parts: string[] = [];
  for (const item of output) {
    if (item.type !== "message" || item.role !== "assistant") continue;
    const content = Array.isArray(item.content) ? item.content : [];
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "output_text" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        parts.push((block as { text: string }).text);
      }
    }
  }
  return parts.join("\n\n").trim();
}

export type { OmnigentClientConfig };
