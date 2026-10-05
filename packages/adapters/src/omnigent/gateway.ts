// Runs a Nova run on Omnigent instead of the built-in run executor, whenever the Omnigent
// connection (OMNIGENT_URL + OMNIGENT_PROXY_SECRET, ./env.ts) is configured. Deliberately narrow for week 1: only a plain user message on a
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
import { STEERING_CONTINUATION_PROMPT } from "@aiden/db";
import { getLogger } from "@aiden/logging";
import { redactReplyCard, turnBlocks } from "./cards.js";
import {
  createOmnigentSession,
  findOmnigentAgentIdByName,
  getOmnigentSession,
  isSessionNotFoundError,
  type OmnigentClientConfig,
  postOmnigentMessage,
  putOmnigentTimezone,
  streamOmnigentSession,
  switchOmnigentAgent,
} from "./client.js";
import { DEFAULT_OMNIGENT_SUPERCHAT_CONFIG, type OmnigentSuperChatConfig } from "./env.js";

/** Sandbox provider name Omnigent's "computer" launcher registers under (see
 * docs/omnigent-spike.md) — selected explicitly on every managed create so a deployment that
 * also offers other sandbox providers still routes the runner into the Muse's own computer. */
const COMPUTER_SANDBOX_PROVIDER = "computer";

/** Value stored in OmnigentSession.runnerLocation: every session's runner lives in the Muse's
 * own computer. The column is kept (no migration); a stored value other than this (a retired
 * "local" session) is recreated on its next turn. */
const RUNNER_LOCATION = "computer";

/** What a person sees when a turn cannot run for an engine-side reason (details go to the log). */
export const CHAT_UNAVAILABLE_MESSAGE = "Chat is not available right now.";

export interface OmnigentGatewayDeps {
  prisma: PrismaClient;
  events: ThreadEvents;
  client: OmnigentClientConfig;
  /** Secret values redacted from the assistant's reply before it is persisted. */
  secrets: string[];
  /** Built-in Omnigent agent bundle name Nova Conversation turns run on — resolved once at
   * boot from `OMNIGENT_AGENT_NAME` (./env.ts). */
  agentName: string;
  /** Settings documented in docs/super-chat/README.md's Settings table
   * (./env.ts#omnigentSuperChatConfigFromEnv). Defaults apply when omitted, so existing
   * callers/tests that construct deps by hand keep today's behavior unchanged. */
  config?: OmnigentSuperChatConfig;
}

/** Triggers the engine runs as an ordinary turn: a typed message, a Teach "Test" run (the
 * skill's instructions are the prompt) and a follow-up such as an Idea's "Do it". */
const ENGINE_RUN_TRIGGERS: ReadonlySet<string> = new Set(["user", "skill", "follow_up"]);

/**
 * Fails a queued run the engine cannot handle (goal threads, routines, webhooks, ...) once and
 * clearly, so the Pi executor path (a Computer Nova no longer keeps for engine Muses, ADR 0004)
 * is never entered and the job is not retried 25 times.
 */
export async function failRunUnsupportedOnOmnigent(
  deps: OmnigentGatewayDeps,
  runId: string,
  workerId: string,
): Promise<void> {
  const run = await deps.prisma.run.findUnique({ where: { id: runId } });
  if (run?.status !== "queued") return;
  const fence = run.leaseFence + 1;
  const leased = await deps.prisma.run.updateMany({
    where: { id: runId, status: "queued" },
    data: { status: "running", leaseOwner: workerId, leaseFence: fence, startedAt: new Date() },
  });
  if (leased.count !== 1) return;
  const attempt = await deps.prisma.attempt.create({ data: { runId, fence, status: "running" } });
  await deps.events.finalizeRun({
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
    runId,
    taskId: run.taskId,
    attemptId: attempt.id,
    leaseOwner: workerId,
    leaseFence: fence,
    outcome: "failed",
    error: `Runs started by "${run.trigger}" are not supported by the Nova engine yet.`,
  });
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
  if (run?.status !== "queued" || !ENGINE_RUN_TRIGGERS.has(run.trigger)) return false;

  const thread = await deps.prisma.thread.findUnique({
    where: { id: run.threadId },
    select: { botId: true, goalId: true },
  });
  if (!thread || thread.botId !== run.botId || thread.goalId) return false;

  const config = deps.config ?? DEFAULT_OMNIGENT_SUPERCHAT_CONFIG;
  const fence = run.leaseFence + 1;
  const leased = await deps.prisma.run.updateMany({
    where: { id: runId, status: "queued" },
    data: {
      status: "running",
      leaseOwner: workerId,
      leaseFence: fence,
      startedAt: new Date(),
      leaseExpiresAt: new Date(Date.now() + config.leaseDurationMs),
      error: null,
    },
  });
  // Lost the claim race to another worker invocation; it owns finishing this run.
  if (leased.count !== 1) return true;

  const attempt = await deps.prisma.attempt.create({
    data: { runId, fence, status: "running" },
  });

  try {
    const [user, task] = await Promise.all([
      deps.prisma.user.findUniqueOrThrow({
        where: { id: run.userId },
        select: { email: true, timezone: true },
      }),
      deps.prisma.task.findUniqueOrThrow({ where: { id: run.taskId }, select: { prompt: true } }),
    ]);

    // The engine reads the person's zone from its own per-owner preference for the per-turn
    // local-time line and for scheduled tasks created without a timezone; Nova owns the value.
    // Best-effort and idempotent (a partial PUT), so it runs every turn and a change in
    // Settings reaches the engine before the next message.
    if (user.timezone) {
      try {
        await putOmnigentTimezone(deps.client, user.email, user.timezone);
      } catch (error) {
        getLogger().error("omnigent gateway: timezone sync failed, continuing", error);
      }
    }

    const sessionId = await ensureOmnigentSession(deps, user.email, run, deps.agentName);
    // Keeps an active Super Chat inside the mirror job's lookback window (./mirror.ts,
    // ./env.ts's `mirrorLookbackMs`) even on a long-running or low-traffic Muse whose session
    // row would otherwise only get touched by `createBoundOmnigentSession`/`switch-agent`.
    // Best-effort: a failure here only risks the mirror job scanning one fewer tick, never a
    // lost turn. Plain try/await (not `.catch()` chained on the call) so a test double that
    // returns `undefined` instead of a Promise cannot throw "catch is not a function" here.
    try {
      await deps.prisma.omnigentSession.update({
        where: { botId: run.botId },
        data: { updatedAt: new Date() },
      });
    } catch (error) {
      getLogger().error("omnigent gateway: bumping session updatedAt failed", error);
    }
    // Messages the person sent while a run was active are SteeringMessage rows, not Task.prompt:
    // a continuation's prompt is only a marker. Claim them so the engine gets every exact text.
    const steering = await deps.events.claimSteering({
      threadId: run.threadId,
      botId: run.botId,
      runId,
      leaseOwner: workerId,
      leaseFence: fence,
      seenIds: [],
    });
    const turnInput = buildTurnInput(
      task.prompt,
      steering.map((item) => item.text),
    );
    const { text, lastItemId, items } = await sendTurnAndAwaitReply(
      deps,
      user.email,
      sessionId,
      turnInput,
      config,
    );
    const redacted = redactSecrets(text, deps.secrets);
    if (containsSecret(redacted, deps.secrets)) {
      throw new Error("refusing to persist a secret in the thread");
    }

    // Mirror job dedup (docs/super-chat/WIRING.md slice A1, ./mirror.ts): this turn's reply is
    // about to be delivered through the normal run path below, so the mirror job must never
    // look at it (or anything before it) again. Best-effort: a failure here only risks a
    // harmless duplicate mirrored message, never a lost reply.
    if (lastItemId) {
      await deps.prisma.omnigentSession
        .update({ where: { botId: run.botId }, data: { lastMirroredItemId: lastItemId } })
        .catch((error) =>
          getLogger().error("omnigent gateway: recording lastMirroredItemId failed", error),
        );
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
      blocks: turnBlocks(items, redacted).map((block) => {
        if (block.kind === "reply_card") return redactReplyCard(block, deps.secrets);
        if (block.kind === "helper") {
          return { ...block, title: redactSecrets(block.title, deps.secrets) };
        }
        return block;
      }),
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

/**
 * The text the engine turn carries: the task prompt, then each queued/steering message verbatim
 * in order. A steering continuation's prompt is a bare marker, so it is replaced by the person's
 * messages; with none to send there is nothing real to say, so the turn fails instead of
 * sending a placeholder.
 */
export function buildTurnInput(prompt: string, steeringTexts: string[]): string {
  const texts = steeringTexts.filter((text) => text.trim().length > 0);
  if (prompt === STEERING_CONTINUATION_PROMPT) {
    if (texts.length === 0) throw new Error("steering continuation has no user message text");
    return texts.join("\n\n");
  }
  return texts.length ? [prompt, ...texts].join("\n\n") : prompt;
}

/** Turns on Omnigent's Super Chat capability (docs/super-chat/README.md, SUPERSIDE-CHAT.md):
 * Rollover, Memory, Side Chats, Sub-agents and the Activity Feed, for this session and
 * everything created from it. Fixed at session-creation time — a session without it is
 * recreated the next time a turn runs on it (see `checkSessionRepair`). */
const SUPERSIDE_CHAT_MODE_LABEL = "omnigent.context.mode";
const SUPERSIDE_CHAT_MODE_VALUE = "superside-chat";

/** Session labels the Super Chat is created with. */
function sessionLabels(
  run: { userId: string; spaceId: string; botId: string },
  computerKey?: string | null,
) {
  return {
    "nova.user": run.userId,
    "nova.space": run.spaceId,
    "nova.bot": run.botId,
    // The computer Nova shows the person (shared per space in team mode): the engine
    // launches the Muse's runner on this same machine.
    ...(computerKey ? { "nova.computer": computerKey } : {}),
    "nova.scope": "private",
    [SUPERSIDE_CHAT_MODE_LABEL]: SUPERSIDE_CHAT_MODE_VALUE,
  };
}

/** The Muse's Nova computer key (Computer.homeKey), or null when it has none yet. */
async function museComputerKey(deps: OmnigentGatewayDeps, botId: string): Promise<string | null> {
  const bot = await deps.prisma.bot.findUnique({
    where: { id: botId },
    select: { computer: { select: { homeKey: true } } },
  });
  return bot?.computer?.homeKey ?? null;
}

/**
 * One Omnigent session per Muse (bot), stored so every turn continues the same conversation.
 *
 * Recreates the session (a fresh Omnigent session, since there is no switch-host RPC) when
 * either:
 * - it was bound on a runner location other than the Muse's computer (a retired "local"
 *   binding from before that option was removed), or
 * - the existing session never got a runner bound at all (`checkSessionRepair`) — the fix for
 *   sessions created before this gateway set `host_type`/`host_id` at all, which otherwise fail
 *   every turn with Omnigent's "no runner bound for session" error forever.
 *
 * Otherwise, when the recorded `agentName` no longer matches `desiredAgentName`, switches it in
 * place — the session is idle between turns, which is switch-agent's only precondition
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
    // A retired runner location recreates unconditionally (the stale session's health is
    // irrelevant once its own binding no longer applies), so only spend a snapshot fetch on
    // the repair check when the binding is current.
    if (existing.runnerLocation !== RUNNER_LOCATION) {
      return await createBoundOmnigentSession(deps, email, run, desiredAgentName);
    }
    const repair = await checkSessionRepair(deps, email, existing.omnigentSessionId);
    if (repair.needsRepair) {
      return await createBoundOmnigentSession(deps, email, run, desiredAgentName);
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

  return await createBoundOmnigentSession(deps, email, run, desiredAgentName);
}

interface SessionRepairCheck {
  needsRepair: boolean;
}

/**
 * Needs repair when a reused session's Omnigent side never got a runner bound (`host_id` null)
 * — the bug this gateway's `host_type`/`host_id` binding fixes, for any session created before
 * it did — or is missing the Super Chat mode label (docs/super-chat/WIRING.md: "an older
 * session without it is replaced on the next turn", since the label is fixed at creation and
 * there is no "add a label" RPC). Fails OPEN (`needsRepair: false`) on a snapshot-fetch error so
 * a transient Omnigent hiccup cannot force a recreate on every single turn; a genuine problem
 * still surfaces from `postOmnigentMessage` right after.
 */
async function checkSessionRepair(
  deps: OmnigentGatewayDeps,
  email: string,
  omnigentSessionId: string,
): Promise<SessionRepairCheck> {
  try {
    const snapshot = await getOmnigentSession(deps.client, email, omnigentSessionId);
    const needsRepair =
      snapshot.host_id == null ||
      snapshot.labels?.[SUPERSIDE_CHAT_MODE_LABEL] !== SUPERSIDE_CHAT_MODE_VALUE;
    return { needsRepair };
  } catch (error) {
    // A session the engine no longer has can never take a turn: recreate it.
    if (isSessionNotFoundError(error)) return { needsRepair: true };
    getLogger().error("omnigent gateway: session snapshot check failed, continuing", error);
    return { needsRepair: false };
  }
}

/**
 * Creates a fresh Omnigent session whose runner is launched inside the Muse's own computer
 * (`host_type: "managed"` with the "computer" sandbox provider, docs/omnigent-spike.md "Nova
 * computer" launcher) and records it as this bot's current session, overwriting whatever was
 * there (a stale/unbound session). Always resets `lastMirroredItemId` to null: a fresh Omnigent
 * session has a different item id space, so a cursor into the old one would either match
 * nothing (harmless) or, worse, collide with an unrelated item id in the new session — see
 * ./mirror.ts.
 */
async function createBoundOmnigentSession(
  deps: OmnigentGatewayDeps,
  email: string,
  run: { userId: string; spaceId: string; botId: string },
  desiredAgentName: string,
): Promise<string> {
  const agentId = await findOmnigentAgentIdByName(deps.client, email, desiredAgentName);
  if (!agentId) {
    getLogger().error(
      `omnigent gateway: no agent bundle named "${desiredAgentName}" is registered`,
    );
    throw new Error(CHAT_UNAVAILABLE_MESSAGE);
  }
  const computerKey = await museComputerKey(deps, run.botId);
  const session = await createOmnigentSession(deps.client, email, {
    agentId,
    labels: sessionLabels(run, computerKey),
    title: "Nova Conversation",
    hostType: "managed",
    sandboxProvider: COMPUTER_SANDBOX_PROVIDER,
  });
  const saved = await deps.prisma.omnigentSession.upsert({
    where: { botId: run.botId },
    create: {
      botId: run.botId,
      omnigentSessionId: session.id,
      agentName: desiredAgentName,
      runnerLocation: RUNNER_LOCATION,
      lastMirroredItemId: null,
    },
    update: {
      omnigentSessionId: session.id,
      agentName: desiredAgentName,
      runnerLocation: RUNNER_LOCATION,
      lastMirroredItemId: null,
    },
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
      throw new Error(`no agent bundle named "${desiredAgentName}" is registered`);
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
  config: OmnigentSuperChatConfig,
): Promise<{
  text: string;
  lastItemId: string | undefined;
  /** The turn's finished items in order (messages and tool calls), for reply cards. */
  items: Array<Record<string, unknown>>;
}> {
  const signal = AbortSignal.timeout(config.turnTimeoutMs);
  const iterator = streamOmnigentSession(deps.client, email, sessionId, signal)[
    Symbol.asyncIterator
  ]();
  const first = iterator.next();
  await postOmnigentMessage(deps.client, email, sessionId, turnInput);

  // Omnigent streams each finished item as response.output_item.done and may leave
  // response.completed's own output empty, so the reply is the last assistant message seen.
  // lastItemId tracks the newest item's id regardless of role, so the mirror job's "after"
  // cursor (./mirror.ts) always starts strictly past everything this turn produced.
  let lastReply = "";
  let lastItemId: string | undefined;
  const items: Array<Record<string, unknown>> = [];
  let step = await first;
  while (!step.done) {
    const event = step.value;
    if (event.type === "response.output_item.done") {
      const item = event.item as Record<string, unknown> | undefined;
      if (typeof item?.id === "string") lastItemId = item.id;
      if (item) items.push(item);
      const text = item ? extractAssistantText([item]) : "";
      if (text) lastReply = text;
    }
    if (event.type === "response.completed") {
      const response = event.response as { output?: Array<Record<string, unknown>> } | undefined;
      for (const item of response?.output ?? []) {
        if (typeof item.id === "string") lastItemId = item.id;
      }
      const output = response?.output ?? [];
      return {
        text: extractAssistantText(output) || lastReply,
        lastItemId,
        items: output.length ? output : items,
      };
    }
    if (event.type === "response.failed" || event.type === "response.error") {
      // Omnigent nests the failure under response.error, like response.completed's output.
      const response = event.response as { error?: { message?: string } } | undefined;
      const message =
        response?.error?.message ||
        (event.error as { message?: string } | undefined)?.message ||
        "";
      if (!message) getLogger().error("omnigent gateway: turn failed without a message");
      throw new Error(message || CHAT_UNAVAILABLE_MESSAGE);
    }
    step = await iterator.next();
  }
  getLogger().error("omnigent gateway: session stream ended before response.completed");
  throw new Error(CHAT_UNAVAILABLE_MESSAGE);
}

/** `response.output` items → assistant message text (OpenAI Responses-style content parts).
 * Also reused by ./mirror.ts for the flattened item shape `GET .../items` returns (same
 * `{type, role, content}` fields — engine/omnigent/omnigent/entities/conversation.py's
 * `to_api_dict`). */
export function extractAssistantText(output: Array<Record<string, unknown>>): string {
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
