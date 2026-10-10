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

import { parseAttachmentReferences, WORKSPACE_UPLOADS_PREFIX } from "@nova/core";
import type { PrismaClient, ThreadEvents } from "@nova/db";
import { STEERING_CONTINUATION_PROMPT } from "@nova/db";
import { getLogger } from "@nova/logging";
import type { OmnigentPostedMessage } from "./client.js";
import {
  adoptOmnigentMuse,
  getOmnigentMuse,
  getOmnigentSession,
  interruptOmnigentSession,
  OmnigentApiError,
  type OmnigentClientConfig,
  type OmnigentConnection,
  omnigentClientFor,
  omnigentErrorCopy,
  postOmnigentMessage,
  putOmnigentTimezone,
  readOmnigentFile,
  streamOmnigentSession,
  WORKSPACE_FILE_MAX_BYTES,
} from "./client.js";
import { DEFAULT_OMNIGENT_SUPERCHAT_CONFIG, type OmnigentSuperChatConfig } from "./env.js";

/** What a person sees when a turn cannot run for an engine-side reason (details go to the log). */
export const CHAT_UNAVAILABLE_MESSAGE = "Chat is not available right now.";

/** What a person sees when the engine failed in a way with no public copy. The detail (an
 * engine status and body) goes to the log only. */
export const ENGINE_FAILED_MESSAGE = "Nova couldn't start. Try again in a moment.";
/** A turn the engine itself reported as failed: its message is written for the person. */
export class OmnigentTurnFailure extends Error {}

export const ENGINE_INTERRUPTED_MESSAGE = "Nova was interrupted. Send your message again.";

/** The engine stopped answering: no progress and no word on the turn. Honest about it, never a
 * "couldn't start". */
export const ENGINE_NO_ANSWER_MESSAGE =
  "Nova stopped responding before it finished. Send your message again.";

/** The Computer would not start (the engine's launch failed, or its runner never connected). The
 * engine's own wording names logs and hosts, so the person gets this calm line instead. */
export const COMPUTER_START_FAILED_MESSAGE =
  "Couldn't start your Computer. Send your message again.";

/** Whether a stream event says the Computer could not be started: a failed launch stage, or a
 * failed session whose error code is `runner_unavailable` (also nested under `response.error`). */
function isComputerStartFailure(event: { type: string; [key: string]: unknown }): boolean {
  if (event.type === "session.sandbox_status") return event.stage === "failed";
  const nested = (event.response as { error?: { code?: string } } | undefined)?.error;
  const error = (event.error as { code?: string } | undefined) ?? nested;
  if (event.type === "session.status") {
    return event.status === "failed" && error?.code === "runner_unavailable";
  }
  if (event.type === "response.failed" || event.type === "response.error") {
    return error?.code === "runner_unavailable";
  }
  return false;
}

/** Errors from the HTTP stack when the engine connection drops mid-turn (an engine restart or a
 * network blip): undici's "terminated"/"fetch failed" and the socket codes behind them. */
const CONNECTION_DROP_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE", "UND_ERR_SOCKET"]);

function isConnectionDrop(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message === "terminated" || error.message === "fetch failed") return true;
  const cause = (error as { cause?: unknown }).cause as { code?: unknown } | undefined;
  const code = (error as { code?: unknown }).code ?? cause?.code;
  return typeof code === "string" && CONNECTION_DROP_CODES.has(code);
}

/** The failure text stored on a failed run, which the UI shows: the engine code's copy, a line
 * for a dropped connection, else a generic line. Raw details go to the logs, never the UI. */
export function publicRunError(error: unknown): string {
  const copy = omnigentErrorCopy(error);
  if (copy) return copy;
  if (error instanceof OmnigentTurnFailure) return error.message;
  if (isConnectionDrop(error)) return ENGINE_INTERRUPTED_MESSAGE;
  if (isTimeout(error)) return ENGINE_NO_ANSWER_MESSAGE;
  return ENGINE_FAILED_MESSAGE;
}

/** A call that ran out of time (an aborted `fetch`, an `AbortSignal.timeout`). */
function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

export interface OmnigentGatewayDeps {
  prisma: PrismaClient;
  events: ThreadEvents;
  /** The engine connection; each turn binds it to the run's space (the tenant). */
  client: OmnigentConnection;
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
    select: { botId: true, goalId: true, nextEventSeq: true },
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
    const client = omnigentClientFor(deps.client, run.spaceId);
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
        await putOmnigentTimezone(client, user.email, user.timezone);
      } catch (error) {
        getLogger().error("omnigent gateway: timezone sync failed, continuing", error);
      }
    }

    const sessionId = await resolveMuseSession(deps, client, user.email, run.botId);
    // Thread events from here on wake the turn when the person sends a message: read before the
    // first claim, so a message committed in between is still seen.
    const cursor = (thread.nextEventSeq ?? 1) - 1;
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
    const outcome = await sendTurnAndAwaitCompletion(client, user.email, sessionId, turnInput, {
      config,
      // Messages the person sends while the turn runs reach it as it works (the engine steers
      // them in, or queues them), instead of waiting for a continuation after it ends.
      steering: {
        runId,
        claimedAtStart: steering.map((item) => item.id),
        signals: (signal) => deps.events.follow(run.threadId, cursor, signal),
        claim: (seenIds) =>
          deps.events.claimSteering({
            threadId: run.threadId,
            botId: run.botId,
            runId,
            leaseOwner: workerId,
            leaseFence: fence,
            seenIds,
          }),
        // The engine has the message now; a continuation must not send it again.
        forwarded: async (ids) => {
          await deps.prisma.steeringMessage.deleteMany({ where: { id: { in: ids } } });
        },
        // The engine never got it: unclaimed, the continuation after this run sends it.
        release: async (ids) => {
          await deps.prisma.steeringMessage.updateMany({
            where: { id: { in: ids } },
            data: { claimedAt: null },
          });
        },
      },
      // The run is still being worked on: keep its lease while the engine shows progress.
      progress: async () => {
        await deps.prisma.run.updateMany({
          where: { id: runId, status: "running", leaseOwner: workerId, leaseFence: fence },
          data: { leaseExpiresAt: new Date(Date.now() + config.leaseDurationMs) },
        });
      },
    });
    // Stopped in Nova: the stop already settled the run.
    if (outcome === "cancelled") return true;

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
      // The reply lives in the engine's transcript (ADR 0009); this run only tracks the turn.
      blocks: [],
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
        error: publicRunError(error),
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

/**
 * The Muse's Conversation, as the engine decides it (ADR 0009): `GET /v1/me/muse` finds the
 * person's Muse for this space, or creates it on the engine's default agent.
 *
 * A Conversation Nova started before that is claimed first, once: its session is adopted with
 * `POST /v1/me/muse/adopt`, so the person keeps it. The row remembers the adoption
 * (`engineAdoptedAt`) and then simply mirrors what the engine answers.
 */
async function resolveMuseSession(
  deps: OmnigentGatewayDeps,
  client: OmnigentClientConfig,
  email: string,
  botId: string,
): Promise<string> {
  const existing = await deps.prisma.omnigentSession.findUnique({ where: { botId } });
  if (existing && !existing.engineAdoptedAt) {
    await adoptExistingConversation(client, email, existing.omnigentSessionId);
  }
  const muse = await getOmnigentMuse(client, email);
  const adoptedAt = existing?.engineAdoptedAt ?? new Date();
  await deps.prisma.omnigentSession.upsert({
    where: { botId },
    create: {
      botId,
      omnigentSessionId: muse.session_id,
      agentName: muse.agent,
      engineAdoptedAt: adoptedAt,
    },
    update: {
      omnigentSessionId: muse.session_id,
      agentName: muse.agent,
      engineAdoptedAt: adoptedAt,
    },
  });
  return muse.session_id;
}

/**
 * Claims a Conversation Nova started before the engine owned the Muse. Done when the engine
 * adopts it, or already has it as the Muse. A session the engine no longer has, or one that was
 * never a Super Chat, has nothing to keep, so the engine's own Muse takes over. Anything else
 * (another Muse already set, another space) fails the turn rather than replacing the
 * Conversation, and is retried on the next one.
 */
async function adoptExistingConversation(
  client: OmnigentClientConfig,
  email: string,
  sessionId: string,
): Promise<void> {
  try {
    await adoptOmnigentMuse(client, email, sessionId);
  } catch (error) {
    if (!(error instanceof OmnigentApiError)) throw error;
    if (error.code === "not_found" || error.code === "not_a_super_chat") {
      getLogger().error("omnigent gateway: old Conversation cannot be adopted, using the Muse", {
        code: error.code,
      });
      return;
    }
    if (error.code === "muse_already_set") {
      const current = await getOmnigentMuse(client, email);
      if (current.session_id === sessionId) return;
    }
    getLogger().error("omnigent gateway: adopting the existing Conversation failed", error);
    throw error;
  }
}

/**
 * The images a turn refers to, read back from the Computer so the model sees them: every
 * `image/*` attachment line under `your_files/uploads/` (<= 5 MiB each). Best effort: a file
 * that cannot be read stays a path line in the text.
 */
export async function readTurnImages(
  client: OmnigentClientConfig,
  email: string,
  sessionId: string,
  turnInput: string,
): Promise<Array<{ mimeType: string; dataBase64: string }>> {
  const images: Array<{ mimeType: string; dataBase64: string }> = [];
  const seen = new Set<string>();
  for (const line of turnInput.split("\n")) {
    const { attachments } = parseAttachmentReferences(line);
    for (const ref of attachments) {
      if (!ref.mimeType.startsWith("image/") || ref.size > WORKSPACE_FILE_MAX_BYTES) continue;
      if (!ref.path.startsWith(WORKSPACE_UPLOADS_PREFIX) || seen.has(ref.path)) continue;
      seen.add(ref.path);
      try {
        const file = await readOmnigentFile(client, email, sessionId, ref.path);
        if (
          file.truncated ||
          file.bytes.length === 0 ||
          file.bytes.length > WORKSPACE_FILE_MAX_BYTES
        ) {
          continue;
        }
        images.push({
          mimeType: ref.mimeType,
          dataBase64: Buffer.from(file.bytes).toString("base64"),
        });
      } catch (error) {
        getLogger().error("omnigent gateway: could not read an attached image back", error);
      }
    }
  }
  return images;
}

/** What `sendTurnAndAwaitCompletion` needs to hand the engine messages sent during the turn. */
export interface SteeringFeed {
  /** The run whose turn this is; its `run.cancelled` ends the wait (and stops the engine turn). */
  runId: string;
  /** The thread's events from the turn's start: each user message is a reason to claim. */
  signals(signal: AbortSignal): AsyncIterable<{ type: string; runId?: string; payload: unknown }>;
  /** Steering ids the turn's own message already carries; never claimed again. */
  claimedAtStart: string[];
  /** Claims the person's new messages for this run; `seenIds` are the ones already handed over. */
  claim(seenIds: string[]): Promise<Array<{ id: string; text: string }>>;
  /** The engine holds these messages now (it persisted them): a continuation must not resend. */
  forwarded(ids: string[]): Promise<void>;
  /** The engine never got them: they wait, unclaimed, for the continuation. */
  release(ids: string[]): Promise<void>;
}

interface TurnOptions {
  config: OmnigentSuperChatConfig;
  steering?: SteeringFeed;
  /** Called while the engine shows the turn is alive, to keep the run's lease. */
  progress?: () => Promise<void>;
}

/** How a dropped engine stream is retried before the run fails (an engine restart takes seconds). */
const STREAM_REOPEN_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000];
/** How long a (re)opened stream may take to send its ready heartbeat (it sends one at once). */
const READY_WAIT_MS = 10_000;

/**
 * Posts the turn's message, then follows the engine session until it is idle with nothing
 * waiting, so the run tracks the turn (working row, stop, failure). The reply itself is not kept
 * here: the engine's transcript holds it (ADR 0009).
 *
 * The stream is open before the post: the engine's first event (its ready heartbeat) comes once
 * this subscriber is registered, so no event of the turn can be missed.
 *
 * Messages the person sends while the turn runs are posted as they arrive (the thread's own
 * event signal wakes the loop). The engine owns them from there: its runner steers each into the
 * running turn through the harness's own steer, or runs it right after, and reports `idle` only
 * once nothing waits. Every post answers with the runner's number for the turn the message
 * started or joined; the run ends at an `idle` edge for that turn or a later one.
 *
 * No fixed deadline: a turn may work as long as the engine says it is. When nothing has happened
 * for a while, the engine's snapshot is asked; a dropped stream is reopened and asked the same.
 */
async function sendTurnAndAwaitCompletion(
  client: OmnigentClientConfig,
  email: string,
  sessionId: string,
  turnInput: string,
  options: TurnOptions,
): Promise<"completed" | "cancelled"> {
  const stop = new AbortController();
  const inbox = new Inbox();
  let generation = 0;
  let streamStop: AbortController | undefined;
  /** Opens (or reopens) the engine stream; items of an older stream are ignored. */
  const openStream = () => {
    streamStop?.abort();
    const current = new AbortController();
    streamStop = current;
    generation += 1;
    const gen = generation;
    const signal = AbortSignal.any([stop.signal, current.signal]);
    void pump(streamOmnigentSession(client, email, sessionId, signal), inbox, gen);
    return gen;
  };
  const signals = options.steering?.signals(stop.signal);
  if (signals) void pumpSignals(signals, inbox);
  try {
    return await runTurn({ client, email, sessionId, turnInput, inbox, options, openStream });
  } finally {
    // Aborting ends the HTTP stream and the thread follow; both pumps then stop.
    stop.abort();
  }
}

type EngineEvent = { type: string; [key: string]: unknown };
type ThreadSignal = { type: string; runId?: string; payload: unknown };
type Inbound =
  | { kind: "event"; event: EngineEvent; gen: number }
  | { kind: "signal"; event: ThreadSignal }
  | { kind: "end"; gen: number }
  | { kind: "error"; error: unknown; gen: number }
  | { kind: "quiet" };

/** One ordered queue for everything the turn reacts to: engine events and thread signals. A
 * wait with nothing arriving for `quietMs` yields `quiet`. */
class Inbox {
  private readonly items: Inbound[] = [];
  private waiting: ((item: Inbound) => void) | undefined;

  push(item: Inbound): void {
    const waiting = this.waiting;
    if (waiting) {
      this.waiting = undefined;
      waiting(item);
    } else this.items.push(item);
  }

  /** Puts an item back at the front, to be handled next. */
  unshift(item: Inbound): void {
    this.items.unshift(item);
  }

  next(quietMs?: number): Promise<Inbound> {
    const item = this.items.shift();
    if (item) return Promise.resolve(item);
    return new Promise((resolve) => {
      const timer =
        quietMs === undefined
          ? undefined
          : setTimeout(() => {
              if (this.waiting === deliver) this.waiting = undefined;
              resolve({ kind: "quiet" });
            }, quietMs);
      const deliver = (next: Inbound) => {
        clearTimeout(timer);
        resolve(next);
      };
      this.waiting = deliver;
    });
  }
}

/** Feeds an engine stream into the inbox; its end or failure is an item too. */
async function pump(source: AsyncIterable<EngineEvent>, inbox: Inbox, gen: number): Promise<void> {
  try {
    for await (const event of source) inbox.push({ kind: "event", event, gen });
    inbox.push({ kind: "end", gen });
  } catch (error) {
    inbox.push({ kind: "error", error, gen });
  }
}

/** Feeds the thread's signals into the inbox; a failure only stops the wake-ups. */
async function pumpSignals(source: AsyncIterable<ThreadSignal>, inbox: Inbox): Promise<void> {
  try {
    for await (const event of source) inbox.push({ kind: "signal", event });
  } catch (error) {
    getLogger().warn("omnigent gateway: thread signals stopped", { error: String(error) });
  }
}

async function postTurn(
  client: OmnigentClientConfig,
  email: string,
  sessionId: string,
  text: string,
): Promise<OmnigentPostedMessage> {
  const images = await readTurnImages(client, email, sessionId, text);
  // The message goes as the person wrote it (their words and the attachment reference lines).
  // The Computer reads the referenced files when the turn starts and puts their framed text in
  // front of the message for the model only; it is never part of the stored message.
  const sent = text;
  return images.length
    ? postOmnigentMessage(client, email, sessionId, sent, images)
    : postOmnigentMessage(client, email, sessionId, sent);
}

interface TurnContext {
  client: OmnigentClientConfig;
  email: string;
  sessionId: string;
  turnInput: string;
  inbox: Inbox;
  options: TurnOptions;
  openStream: () => number;
}

/** The engine's own word on the session: `running`, `waiting` (on helpers or the person),
 * `idle`, or `failed`. */
type EngineState = "running" | "waiting" | "idle" | "failed";

async function runTurn(ctx: TurnContext): Promise<"completed" | "cancelled"> {
  const { client, email, sessionId, inbox, options } = ctx;
  const steering = options.steering;
  // Asked well within the run's lease, so a quiet but live turn always renews it in time.
  const quietMs = Math.min(options.config.turnTimeoutMs, options.config.leaseDurationMs / 2);
  const seen: string[] = [...(steering?.claimedAtStart ?? [])];
  /** Signals that came before the stream was live: handled once it is. */
  const held: ThreadSignal[] = [];
  /** The latest turn a message of this run started or joined: its `idle` ends the run. */
  let myTurn: number | undefined;

  const progress = () =>
    options.progress?.().catch((error) => {
      getLogger().error("omnigent gateway: could not renew the run lease", error);
    });
  /** A steering-row update; a database error is logged, never the turn's failure. */
  const updateRows = async (update: (ids: string[]) => Promise<void>, ids: string[]) => {
    try {
      await update(ids);
    } catch (error) {
      getLogger().error("omnigent gateway: could not update steering rows", error);
    }
  };
  const joined = (posted: OmnigentPostedMessage | undefined) => {
    if (typeof posted?.turn === "number") myTurn = Math.max(myTurn ?? 0, posted.turn);
  };

  const forwardNewMessages = async () => {
    if (!steering) return;
    for (const message of await steering.claim([...seen])) {
      seen.push(message.id);
      try {
        joined(await postTurn(client, email, sessionId, message.text));
      } catch (error) {
        // Not this run's to fail: the message waits, unclaimed, for the continuation.
        getLogger().error("omnigent gateway: a message sent during the turn was not posted", error);
        await updateRows(steering.release, [message.id]);
        continue;
      }
      // Persisted by the engine, whose runner now owns it: never sent again from here.
      await updateRows(steering.forwarded, [message.id]);
    }
  };

  /** The engine's snapshot of the session; `undefined` when it cannot be read. */
  const engineState = async (): Promise<EngineState | undefined> => {
    const snapshot = await getOmnigentSession(client, email, sessionId).catch(() => undefined);
    const status = snapshot?.status;
    if (status === "idle" || status === "failed" || status === "waiting") return status;
    return status === undefined ? undefined : "running";
  };

  /** The stream being followed; items of an older (dropped) stream are ignored. */
  let currentGen = 0;

  /** Opens a stream and waits for its ready heartbeat (a bounded wait: a quiet one counts as a
   * failed open); thread signals meanwhile are held. */
  const open = async (): Promise<boolean> => {
    currentGen = ctx.openStream();
    while (true) {
      const item = await inbox.next(READY_WAIT_MS);
      if (item.kind === "quiet") return false;
      if (item.kind === "signal") {
        held.push(item.event);
        continue;
      }
      if (item.gen !== currentGen) continue;
      // Any first event proves the subscriber is live; only the heartbeat carries nothing.
      if (item.kind === "event" && item.event.type !== "session.heartbeat") inbox.unshift(item);
      return item.kind === "event";
    }
  };

  /** Reopens the stream until it is live and the engine answers where the session is. */
  const reopen = async (): Promise<EngineState> => {
    for (const delay of STREAM_REOPEN_DELAYS_MS) {
      if (await open()) {
        const state = await engineState();
        if (state) return state;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    getLogger().error("omnigent gateway: the engine stream could not be reopened");
    throw new OmnigentTurnFailure(ENGINE_INTERRUPTED_MESSAGE);
  };

  /** What the engine's own word on the session means for the run. */
  const settle = (state: EngineState): "completed" | undefined => {
    if (state === "failed") throw new OmnigentTurnFailure(ENGINE_INTERRUPTED_MESSAGE);
    if (state === "idle") return "completed";
    // Still running, or waiting on helpers or on the person: keep following, keep the lease.
    void progress();
    return undefined;
  };

  const isStop = (event: ThreadSignal) =>
    event.type === "run.cancelled" && event.runId === steering?.runId;

  const handleSignal = async (event: ThreadSignal): Promise<"cancelled" | undefined> => {
    if (isStop(event)) {
      // Stopped in Nova: stop the engine's turn too.
      await interruptOmnigentSession(client, email, sessionId).catch((error) => {
        getLogger().error("omnigent gateway: could not stop the engine turn", error);
      });
      return "cancelled";
    }
    const role = (event.payload as { role?: unknown } | undefined)?.role;
    if (event.type === "thread.message.created" && role === "user") await forwardNewMessages();
    return undefined;
  };

  // The engine's first event is its ready heartbeat: post only once the stream is live.
  if (!(await open())) await reopen();
  // Stopped before anything was posted: nothing to send, nothing to stop.
  if (held.some(isStop)) return "cancelled";
  joined(await postTurn(client, email, sessionId, ctx.turnInput));

  // The engine's word is asked on a clock, whatever the stream carries (it sends a heartbeat
  // every few seconds), so a long but live turn always keeps its lease.
  let lastCheckAt = Date.now();
  while (true) {
    const signal = held.shift();
    if (signal) {
      if ((await handleSignal(signal)) === "cancelled") return "cancelled";
      continue;
    }
    const item = await inbox.next(quietMs);
    if (item.kind === "quiet" || Date.now() - lastCheckAt >= quietMs) {
      lastCheckAt = Date.now();
      // An unanswered snapshot is treated like a dropped stream: reopened and asked again.
      const state = (await engineState()) ?? (await reopen());
      if (settle(state) === "completed") return "completed";
      if (item.kind === "quiet") continue;
    }
    if (item.kind === "signal") {
      if ((await handleSignal(item.event)) === "cancelled") return "cancelled";
      continue;
    }
    if (item.gen !== currentGen) continue;
    if (item.kind === "end" || item.kind === "error") {
      getLogger().error("omnigent gateway: the engine stream dropped; reopening it", {
        error: item.kind === "error" ? String(item.error) : undefined,
      });
      if (settle(await reopen()) === "completed") return "completed";
      lastCheckAt = Date.now();
      continue;
    }
    const { event } = item;
    if (event.type === "session.heartbeat") continue;
    if (event.status === "idle" && event.type === "session.status") {
      const turn = typeof event.turn === "number" ? event.turn : undefined;
      // Once a message joined a numbered turn, only that turn's (or a later) idle ends the run:
      // an unnumbered idle is the server's own (a refused message), not the runner's.
      if (myTurn === undefined || (turn !== undefined && turn >= myTurn)) return "completed";
    }
    if (event.type === "session.status" && event.status !== "idle") void progress();
    if (isComputerStartFailure(event)) {
      getLogger().error("omnigent gateway: the Computer did not start", {
        type: event.type,
        error: event.error,
      });
      throw new OmnigentTurnFailure(COMPUTER_START_FAILED_MESSAGE);
    }
    if (event.type === "response.failed" || event.type === "response.error") {
      // Omnigent nests the failure under response.error, like response.completed's output.
      const response = event.response as { error?: { message?: string } } | undefined;
      const message =
        response?.error?.message ||
        (event.error as { message?: string } | undefined)?.message ||
        "";
      if (!message) getLogger().error("omnigent gateway: turn failed without a message");
      throw new OmnigentTurnFailure(message || CHAT_UNAVAILABLE_MESSAGE);
    }
  }
}

export type { OmnigentClientConfig, OmnigentConnection };
