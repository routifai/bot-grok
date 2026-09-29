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

import type { NovaRunnerLocationId } from "@aiden/contracts";
import { containsSecret, redactSecrets } from "@aiden/core";
import type { PrismaClient, ThreadEvents } from "@aiden/db";
import { getLogger } from "@aiden/logging";
import {
  createOmnigentHostDirectory,
  createOmnigentSession,
  findOmnigentAgentIdByName,
  getOmnigentSession,
  listOmnigentHostDirectory,
  listOmnigentHosts,
  type OmnigentClientConfig,
  postOmnigentMessage,
  streamOmnigentSession,
  switchOmnigentAgent,
} from "./client.js";
import { agentNameForMuseHarness } from "./harnesses.js";
import { resolveMuseRunnerLocation } from "./runner-location.js";

/** Sandbox provider name Omnigent's "computer" launcher registers under (see
 * docs/omnigent-spike.md) — selected explicitly on every managed create so a deployment that
 * also offers other sandbox providers still routes a "computer" runner location here. */
const COMPUTER_SANDBOX_PROVIDER = "computer";

/** Directory name under a local host's home a Muse's workspace lives in: `~/nova/<botId>`. */
const LOCAL_WORKSPACE_DIR_NAME = "nova";

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
        select: { museHarness: true, museRunnerLocation: true },
      }),
    ]);
    const desiredAgentName = agentNameForMuseHarness(bot.museHarness, deps.agentName);
    const desiredRunnerLocation = resolveMuseRunnerLocation(bot.museRunnerLocation);

    const sessionId = await ensureOmnigentSession(
      deps,
      user.email,
      run,
      desiredAgentName,
      desiredRunnerLocation,
    );
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
 *
 * Recreates the session (a fresh Omnigent session, since there is neither a switch-host nor a
 * switch-location RPC) when either:
 * - the bot's resolved runner location no longer matches the one the session was bound on
 *   (the person changed Bot.museRunnerLocation since), or
 * - the existing session never got a runner bound at all (`sessionNeedsRepair`) — the fix for
 *   sessions created before this gateway set `host_type`/`host_id` at all, which otherwise fail
 *   every turn with Omnigent's "no runner bound for session" error forever.
 *
 * Otherwise, when the recorded `agentName` no longer matches the bot's resolved harness
 * (`desiredAgentName`), switches it in place — the session is idle between turns, which is
 * switch-agent's only precondition
 * (engine/omnigent/omnigent/server/routes/sessions/routes_core.py ~3580-3700).
 */
async function ensureOmnigentSession(
  deps: OmnigentGatewayDeps,
  email: string,
  run: { userId: string; spaceId: string; botId: string },
  desiredAgentName: string,
  desiredRunnerLocation: NovaRunnerLocationId,
): Promise<string> {
  const existing = await deps.prisma.omnigentSession.findUnique({
    where: { botId: run.botId },
  });
  if (existing) {
    const locationChanged = existing.runnerLocation !== desiredRunnerLocation;
    if (locationChanged || (await sessionNeedsRepair(deps, email, existing.omnigentSessionId))) {
      return await createBoundOmnigentSession(
        deps,
        email,
        run,
        desiredAgentName,
        desiredRunnerLocation,
      );
    }
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

  return await createBoundOmnigentSession(
    deps,
    email,
    run,
    desiredAgentName,
    desiredRunnerLocation,
  );
}

/**
 * True when a reused session's Omnigent side never got a runner bound (`host_id` null) — the
 * bug this gateway's `host_type`/`host_id` binding fixes, for any session created before it did.
 * Fails OPEN (returns `false`, i.e. "no repair needed") on a snapshot-fetch error so a transient
 * Omnigent hiccup cannot force a recreate on every single turn; a genuine problem still surfaces
 * from `postOmnigentMessage` right after.
 */
async function sessionNeedsRepair(
  deps: OmnigentGatewayDeps,
  email: string,
  omnigentSessionId: string,
): Promise<boolean> {
  try {
    const snapshot = await getOmnigentSession(deps.client, email, omnigentSessionId);
    return snapshot.host_id == null;
  } catch (error) {
    getLogger().error("omnigent gateway: session snapshot check failed, continuing", error);
    return false;
  }
}

/**
 * Creates a fresh Omnigent session bound to a runner per `runnerLocation` (see
 * `resolveRunnerBinding`) and records it as this bot's current session, overwriting whatever was
 * there (a stale/unbound session, or one bound to a different location).
 */
async function createBoundOmnigentSession(
  deps: OmnigentGatewayDeps,
  email: string,
  run: { userId: string; spaceId: string; botId: string },
  desiredAgentName: string,
  runnerLocation: NovaRunnerLocationId,
): Promise<string> {
  const agentId = await findOmnigentAgentIdByName(deps.client, email, desiredAgentName);
  if (!agentId) {
    throw new Error(`no Omnigent agent bundle named "${desiredAgentName}" is registered`);
  }
  const binding = await resolveRunnerBinding(deps, email, run, runnerLocation);
  const session = await createOmnigentSession(deps.client, email, {
    agentId,
    labels: sessionLabels(run),
    title: "Nova Conversation",
    ...binding,
  });
  const saved = await deps.prisma.omnigentSession.upsert({
    where: { botId: run.botId },
    create: {
      botId: run.botId,
      omnigentSessionId: session.id,
      agentName: desiredAgentName,
      runnerLocation,
    },
    update: { omnigentSessionId: session.id, agentName: desiredAgentName, runnerLocation },
  });
  return saved.omnigentSessionId;
}

type RunnerBinding =
  | { hostType: "managed"; sandboxProvider: string }
  | { hostType: "external"; hostId: string; workspace: string };

/**
 * How a new session binds to a runner for `runnerLocation` (docs/omnigent-spike.md "Nova
 * computer" launcher):
 * - "computer": `host_type: "managed"` with the "computer" sandbox provider, so Omnigent's
 *   server provisions and binds the host itself, inside this Muse's own sandbox computer.
 * - "local": the caller's already-connected `omnigent host` — resolved via `GET /v1/hosts` and
 *   bound directly by `host_id` + an absolute `workspace` path on it. Throws a clear, turn-
 *   failing error when none is online, per docs/omnigent-spike.md's "fail clearly" requirement.
 */
async function resolveRunnerBinding(
  deps: OmnigentGatewayDeps,
  email: string,
  run: { userId: string; spaceId: string; botId: string },
  runnerLocation: NovaRunnerLocationId,
): Promise<RunnerBinding> {
  if (runnerLocation === "computer") {
    return { hostType: "managed", sandboxProvider: COMPUTER_SANDBOX_PROVIDER };
  }
  const hosts = await listOmnigentHosts(deps.client, email);
  // sandbox_provider !== null marks a server-managed host (not a person's own machine) —
  // never a valid "local" target even if it happens to be online right now.
  const online = hosts.find((host) => host.status === "online" && host.sandbox_provider === null);
  if (!online) {
    throw new Error(
      "No connected local host found for this Muse's runner — run `omnigent host` on your " +
        'machine, or switch this Muse\'s runner location back to "computer".',
    );
  }
  const workspace = await resolveLocalWorkspace(deps, email, online.host_id, run.botId);
  return { hostType: "external", hostId: online.host_id, workspace };
}

/**
 * The absolute workspace directory a "local" session starts in on `hostId`: `~/nova/<botId>`,
 * created on first use. Falls back to listing the parent directory when creation reports
 * "already exists" (e.g. a session recreated after `sessionNeedsRepair`, or a directory left
 * over from an earlier local run) — the host's create-directory call reports that case as a
 * plain error, not the resolved absolute path, so it has to be recovered from a listing instead.
 */
async function resolveLocalWorkspace(
  deps: OmnigentGatewayDeps,
  email: string,
  hostId: string,
  botId: string,
): Promise<string> {
  const relativePath = `~/${LOCAL_WORKSPACE_DIR_NAME}/${botId}`;
  try {
    const created = await createOmnigentHostDirectory(deps.client, email, hostId, relativePath);
    return created.path;
  } catch (error) {
    const entries = await listOmnigentHostDirectory(
      deps.client,
      email,
      hostId,
      `~/${LOCAL_WORKSPACE_DIR_NAME}`,
    ).catch(() => []);
    const existing = entries.find((entry) => entry.name === botId && entry.type === "directory");
    if (existing) return existing.path;
    throw new Error(
      `could not create or find a workspace directory for this Muse on host ${hostId}`,
      { cause: error },
    );
  }
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

  // Omnigent streams each finished item as response.output_item.done and may leave
  // response.completed's own output empty, so the reply is the last assistant message seen.
  let lastReply = "";
  let step = await first;
  while (!step.done) {
    const event = step.value;
    if (event.type === "response.output_item.done") {
      const item = event.item as Record<string, unknown> | undefined;
      const text = item ? extractAssistantText([item]) : "";
      if (text) lastReply = text;
    }
    if (event.type === "response.completed") {
      const response = event.response as { output?: Array<Record<string, unknown>> } | undefined;
      return extractAssistantText(response?.output ?? []) || lastReply;
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
