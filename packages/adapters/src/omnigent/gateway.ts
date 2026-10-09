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

import {
  type IngestedAttachment,
  isIngestableAttachmentMimeType,
  parseAttachmentReferences,
  WORKSPACE_UPLOADS_PREFIX,
  withAttachmentContext,
} from "@nova/core";
import type { PrismaClient, ThreadEvents } from "@nova/db";
import { STEERING_CONTINUATION_PROMPT } from "@nova/db";
import { getLogger } from "@nova/logging";
import type { OmnigentPostedMessage } from "./client.js";
import {
  adoptOmnigentMuse,
  getOmnigentMuse,
  getOmnigentSession,
  ingestOmnigentKnowledge,
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
  return ENGINE_FAILED_MESSAGE;
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
  /** The run whose turn this is; its `run.cancelled` ends the wait. */
  runId: string;
  /** The thread's events from the turn's start: each user message is a reason to claim. */
  signals(signal: AbortSignal): AsyncIterable<{ type: string; runId?: string; payload: unknown }>;
  /** Steering ids the turn's own message already carries; never claimed again. */
  claimedAtStart: string[];
  /** Claims the person's new messages for this run; `seenIds` are the ones already handed over. */
  claim(seenIds: string[]): Promise<Array<{ id: string; text: string }>>;
  /** Called once a turn has read the messages with these steering ids. */
  forwarded(ids: string[]): Promise<void>;
  /** Called when no turn will read them: they wait, unclaimed, for the next run. */
  release(ids: string[]): Promise<void>;
}

interface TurnOptions {
  config: OmnigentSuperChatConfig;
  steering?: SteeringFeed;
  /** Called on each sign of progress (a turn starts, a message is settled). */
  progress?: () => Promise<void>;
}

/** How many times a dropped engine stream is reopened (an engine restart takes seconds). */
const STREAM_REOPEN_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000];

/** How a message ended up, per the engine (`session.input.delivery`): `steer`, `turn` and
 * `cancelled` are final, `queued` is not. */
const FINAL_DELIVERIES: ReadonlySet<string> = new Set(["steer", "turn", "cancelled"]);
/** A turn the engine is running for one of these, or for a turn they wait behind. */
const RUNNING_DELIVERIES: ReadonlySet<string> = new Set(["steer", "turn", "queued"]);
/** Every way an engine turn ends. */
const TURN_ENDS: ReadonlySet<string> = new Set([
  "response.completed",
  "response.cancelled",
  "response.incomplete",
]);

/** The engine's account of a message sent to the session (`session.input.delivery`). */
function deliveryOf(event: { type: string; [key: string]: unknown }) {
  if (event.type !== "session.input.delivery") return undefined;
  const data = event.data as { item_id?: unknown; delivered?: unknown } | undefined;
  if (typeof data?.item_id !== "string" || typeof data.delivered !== "string") return undefined;
  return { itemId: data.item_id, delivered: data.delivered };
}

/**
 * What the Computer read of the documents a turn refers to, for the model: each attached PDF,
 * text, Markdown or CSV under `your_files/uploads/` is ingested (the composer already did it
 * before Send, so this answers at once) and comes back as its whole Markdown when short, else a
 * manifest line. Best effort: a file that cannot be read stays a path line.
 */
export async function readTurnAttachmentContext(
  client: OmnigentClientConfig,
  email: string,
  sessionId: string,
  turnInput: string,
): Promise<IngestedAttachment[]> {
  const { attachments } = parseAttachmentReferences(turnInput);
  const items: IngestedAttachment[] = [];
  const seen = new Set<string>();
  for (const ref of attachments) {
    if (!isIngestableAttachmentMimeType(ref.mimeType) || seen.has(ref.path)) continue;
    if (!ref.path.startsWith(WORKSPACE_UPLOADS_PREFIX)) continue;
    seen.add(ref.path);
    try {
      const read = await ingestOmnigentKnowledge(client, email, sessionId, {
        path: ref.path,
        inline: true,
      });
      items.push({
        name: read.name,
        fileId: read.file_id,
        pages: read.pages,
        ...(read.markdown === undefined ? {} : { markdown: read.markdown }),
      });
    } catch (error) {
      getLogger().error("omnigent gateway: could not read an attached file", error);
    }
  }
  return items;
}

/**
 * Posts the turn's message, then reads the live stream until the engine is done with every
 * message this run handed it, so the run tracks the turn (working row, stop, failure). The reply
 * itself is not kept here: the engine's transcript holds it (ADR 0009).
 *
 * The stream is open before the post: the engine's first event (its ready heartbeat) comes once
 * this subscriber is registered, so no event of the turn can be missed.
 *
 * Messages the person sends while the turn runs are posted as they arrive (the thread's own
 * event signal wakes the loop). The engine reports each message exactly once as `steer` (read by
 * the running turn), `turn` (ran as a turn of its own) or `cancelled`, so the run ends when all
 * of its messages are settled and no turn is running: no timers or polling decide it. A
 * message's steering row is deleted once a turn read it, and released for the continuation when
 * none will.
 *
 * A dropped stream (an engine restart) is reopened; the engine's snapshot then says whether the
 * turn is still running, finished, or failed, so the run never waits blind for its deadline.
 */
async function sendTurnAndAwaitCompletion(
  client: OmnigentClientConfig,
  email: string,
  sessionId: string,
  turnInput: string,
  options: TurnOptions,
): Promise<"completed" | "cancelled"> {
  const stop = new AbortController();
  // Each engine turn gets the full budget: a run spanning several turns is not cut short.
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const startTurnClock = () => {
    clearTimeout(deadline);
    deadline = setTimeout(
      () => stop.abort(new DOMException("The turn took too long", "TimeoutError")),
      options.config.turnTimeoutMs,
    );
  };
  startTurnClock();
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
    void pump(
      streamOmnigentSession(client, email, sessionId, signal),
      inbox,
      (event) => ({ kind: "event", event, gen }),
      gen,
    );
    return gen;
  };
  const signals = options.steering?.signals(stop.signal);
  if (signals) void pumpSignals(signals, inbox);
  try {
    return await runTurn(
      { client, email, sessionId, turnInput, inbox, options, startTurnClock, openStream },
      stop.signal,
    );
  } finally {
    clearTimeout(deadline);
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
  | { kind: "timeout" };

/** One ordered queue for everything the turn reacts to: engine events and thread signals. */
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

  next(): Promise<Inbound> {
    const item = this.items.shift();
    if (item) return Promise.resolve(item);
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }
}

/** Feeds an engine stream into the inbox; its end or failure is an item too. */
async function pump(
  source: AsyncIterable<EngineEvent>,
  inbox: Inbox,
  wrap: (value: EngineEvent) => Inbound,
  gen: number,
): Promise<void> {
  try {
    for await (const value of source) inbox.push(wrap(value));
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
  const sent = withAttachmentContext(
    text,
    await readTurnAttachmentContext(client, email, sessionId, text),
  );
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
  startTurnClock: () => void;
  openStream: () => number;
}

async function runTurn(ctx: TurnContext, aborted: AbortSignal): Promise<"completed" | "cancelled"> {
  const { client, email, sessionId, inbox, options } = ctx;
  const steering = options.steering;
  /** The engine's ids of the messages this run posted, and which are settled. */
  const own = new Set<string>();
  const settled = new Set<string>();
  /** Steering rows behind each posted engine message, until a turn reads it or none will. */
  const rowsOf = new Map<string, string[]>();
  const seen: string[] = [...(steering?.claimedAtStart ?? [])];
  /** Signals that came before the stream was live: handled once it is. */
  const held: ThreadSignal[] = [];
  let turnRunning = false;
  /** Set once the stream was reopened: deliveries sent in the gap may have been missed. */
  let missedEvents = false;
  // The deadline aborts the stream; report it as such rather than as a dropped stream.
  aborted.addEventListener("abort", () => inbox.push({ kind: "timeout" }), { once: true });

  const progress = () =>
    options.progress?.().catch((error) => {
      getLogger().error("omnigent gateway: could not renew the run lease", error);
    });
  /** Runs a steering-row update; a database error is logged, never the turn's failure. */
  const settleRows = async (update: (ids: string[]) => Promise<void>, ids: string[]) => {
    if (!ids.length) return;
    try {
      await update(ids);
    } catch (error) {
      getLogger().error("omnigent gateway: could not update steering rows", error);
    }
  };
  const settle = async (itemId: string, delivered: string) => {
    settled.add(itemId);
    const rows = rowsOf.get(itemId) ?? [];
    rowsOf.delete(itemId);
    if (!steering) return;
    // Read by a turn: done. Cancelled: no turn read it, the continuation sends it.
    await settleRows(delivered === "cancelled" ? steering.release : steering.forwarded, rows);
  };
  /** The run ends without these messages read: they go to the continuation. */
  const releaseUnsettled = async () => {
    if (!steering) return;
    const rows = [...rowsOf.values()].flat();
    rowsOf.clear();
    await settleRows(steering.release, rows);
  };
  const track = (posted: OmnigentPostedMessage | undefined, rows: string[]) => {
    if (!posted?.itemId) {
      getLogger().error("omnigent gateway: the engine did not identify a posted message");
      return;
    }
    own.add(posted.itemId);
    if (rows.length) rowsOf.set(posted.itemId, rows);
  };

  const forwardNewMessages = async () => {
    if (!steering) return;
    for (const message of await steering.claim([...seen])) {
      seen.push(message.id);
      try {
        track(await postTurn(client, email, sessionId, message.text), [message.id]);
      } catch (error) {
        // Not this run's to fail: the message waits, unclaimed, for the continuation.
        getLogger().error("omnigent gateway: a message sent during the turn was not posted", error);
        await settleRows(steering.release, [message.id]);
      }
    }
  };

  /** Waits for a (re)opened stream's ready heartbeat; thread signals meanwhile are held. */
  const awaitReady = async (gen: number): Promise<boolean> => {
    while (true) {
      const item = await inbox.next();
      if (item.kind === "timeout") throw new OmnigentTurnFailure(CHAT_UNAVAILABLE_MESSAGE);
      if (item.kind === "signal") {
        held.push(item.event);
        continue;
      }
      if (item.gen !== gen) continue;
      // Any first event proves the subscriber is live; only the heartbeat carries nothing.
      if (item.kind === "event" && item.event.type !== "session.heartbeat") inbox.unshift(item);
      return item.kind === "event";
    }
  };

  /** The stream dropped: reopen it, then let the engine's snapshot say where the turn is. */
  const recover = async (): Promise<"running" | "idle"> => {
    for (const delay of STREAM_REOPEN_DELAYS_MS) {
      if (await awaitReady(ctx.openStream())) {
        const snapshot = await getOmnigentSession(client, email, sessionId).catch(() => undefined);
        if (!snapshot) continue;
        if (snapshot.status === "failed") throw new OmnigentTurnFailure(ENGINE_INTERRUPTED_MESSAGE);
        return snapshot.status === "running" || snapshot.status === "waiting" ? "running" : "idle";
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    getLogger().error("omnigent gateway: the engine stream could not be reopened");
    throw new OmnigentTurnFailure(ENGINE_INTERRUPTED_MESSAGE);
  };

  /** No turn runs any more and some deliveries were missed: whatever this run handed the
   * engine has been answered or is gone; what is unsettled goes to the continuation. */
  const finishBlind = async (): Promise<"completed"> => {
    for (const id of own) settled.add(id);
    await releaseUnsettled();
    return "completed";
  };

  const handleSignal = async (event: ThreadSignal): Promise<"cancelled" | undefined> => {
    if (event.type === "run.cancelled" && event.runId === steering?.runId) {
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
  // A stream that drops before it is live is reopened; nothing is posted until one is.
  if (!(await awaitReady(ctx.openStream()))) await recover();
  track(await postTurn(client, email, sessionId, ctx.turnInput), []);

  try {
    while (true) {
      const signal = held.shift();
      if (signal) {
        if ((await handleSignal(signal)) === "cancelled") return "cancelled";
        continue;
      }
      const item = await inbox.next();
      if (item.kind === "timeout") throw new OmnigentTurnFailure(CHAT_UNAVAILABLE_MESSAGE);
      if (item.kind === "signal") {
        if ((await handleSignal(item.event)) === "cancelled") return "cancelled";
        continue;
      }
      if (item.kind === "end" || item.kind === "error") {
        getLogger().error("omnigent gateway: the engine stream dropped; reopening it", {
          error: item.kind === "error" ? item.error : undefined,
        });
        if ((await recover()) === "running") {
          turnRunning = true;
          missedEvents = true;
          continue;
        }
        return finishBlind();
      }
      const { event } = item;
      const delivery = deliveryOf(event);
      if (delivery) {
        // Only this run's messages count; others belong to another run or a Side Chat.
        if (!own.has(delivery.itemId)) continue;
        if (RUNNING_DELIVERIES.has(delivery.delivered)) turnRunning = true;
        if (FINAL_DELIVERIES.has(delivery.delivered)) {
          await settle(delivery.itemId, delivery.delivered);
          void progress();
        }
      } else if (event.type === "response.created") {
        turnRunning = true;
        ctx.startTurnClock();
        void progress();
        continue;
      } else if (TURN_ENDS.has(event.type)) {
        turnRunning = false;
        if (missedEvents && ![...own].every((id) => settled.has(id))) {
          // A delivery may have gone by while the stream was down: ask the engine instead.
          const snapshot = await getOmnigentSession(client, email, sessionId).catch(
            () => undefined,
          );
          if (snapshot?.status !== "running" && snapshot?.status !== "waiting") {
            return finishBlind();
          }
        }
      } else if (isComputerStartFailure(event)) {
        getLogger().error("omnigent gateway: the Computer did not start", {
          type: event.type,
          error: event.error,
        });
        throw new OmnigentTurnFailure(COMPUTER_START_FAILED_MESSAGE);
      } else if (event.type === "response.failed" || event.type === "response.error") {
        // Omnigent nests the failure under response.error, like response.completed's output.
        const response = event.response as { error?: { message?: string } } | undefined;
        const message =
          response?.error?.message ||
          (event.error as { message?: string } | undefined)?.message ||
          "";
        if (!message) getLogger().error("omnigent gateway: turn failed without a message");
        throw new OmnigentTurnFailure(message || CHAT_UNAVAILABLE_MESSAGE);
      } else {
        continue;
      }
      if (!turnRunning && [...own].every((id) => settled.has(id))) return "completed";
    }
  } catch (error) {
    // Failed or timed out: no turn of this run will read what is still unsettled.
    await releaseUnsettled();
    throw error;
  }
}

export type { OmnigentClientConfig, OmnigentConnection };
