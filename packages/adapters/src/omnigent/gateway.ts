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
import {
  adoptOmnigentMuse,
  getOmnigentMuse,
  ingestOmnigentKnowledge,
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
    await sendTurnAndAwaitCompletion(client, user.email, sessionId, turnInput, config, {
      // Messages the person sends while the turn runs reach it as it works (the engine steers
      // them in, or queues them), instead of waiting for a continuation after it ends.
      claim: async (seenIds) => {
        const pending = await deps.prisma.steeringMessage.findFirst({
          where: {
            botId: run.botId,
            claimedAt: null,
            message: { threadId: run.threadId },
            OR: [{ runId: null }, { runId }],
          },
          select: { id: true },
        });
        if (!pending) return [];
        return deps.events.claimSteering({
          threadId: run.threadId,
          botId: run.botId,
          runId,
          leaseOwner: workerId,
          leaseFence: fence,
          seenIds,
        });
      },
      // The engine has the message now; a continuation must not send it again.
      forwarded: async (ids) => {
        await deps.prisma.steeringMessage.deleteMany({ where: { id: { in: ids } } });
      },
    });

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

/** How often a running turn looks for messages the person sent meanwhile. */
const STEERING_POLL_MS = 1_000;
/** After the turn completes, how long to wait for the engine to say what became of a message sent
 * during it (taken into the turn, or started as the next one). */
const DELIVERY_GRACE_MS = 3_000;

/** What `sendTurnAndAwaitCompletion` needs to hand the engine messages sent during the turn. */
export interface SteeringFeed {
  /** Claims the person's new messages for this run; `seenIds` are the ones already handed over. */
  claim(seenIds: string[]): Promise<Array<{ id: string; text: string }>>;
  /** Called once the engine holds the messages with these steering ids. */
  forwarded(ids: string[]): Promise<void>;
}

/** The engine's account of a message sent during a turn (`session.input.delivery`). */
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
 * Posts the turn's message, then reads the live stream until `response.completed`, so the run
 * tracks the turn (working row, stop, failure). The reply itself is not kept here: the engine's
 * transcript holds it (ADR 0009). The GET stream request is started (its body opened) before the
 * POST so a fast reply cannot race ahead of the listener — see
 * engine/omnigent/omnigent/server/API.md's "Reconnect Contract" note on opening the stream first.
 *
 * Messages the person sends while the turn runs are posted to the engine as they arrive. The
 * engine steers each into the running turn (`steer`), or holds it for the next one (`queued`),
 * and says which on the stream; a queued message runs as a turn of its own, so the run stays
 * open until that turn completes too.
 */
async function sendTurnAndAwaitCompletion(
  client: OmnigentClientConfig,
  email: string,
  sessionId: string,
  turnInput: string,
  config: OmnigentSuperChatConfig,
  steering?: SteeringFeed,
): Promise<void> {
  const stop = new AbortController();
  const signal = AbortSignal.any([AbortSignal.timeout(config.turnTimeoutMs), stop.signal]);
  const iterator = streamOmnigentSession(client, email, sessionId, signal)[Symbol.asyncIterator]();
  try {
    await runTurn(client, email, sessionId, turnInput, iterator, steering);
  } finally {
    // Closing the generator releases its reader; aborting ends the HTTP stream itself.
    stop.abort();
    await iterator.return?.(undefined).catch(() => undefined);
  }
}

async function postTurn(
  client: OmnigentClientConfig,
  email: string,
  sessionId: string,
  text: string,
): Promise<string | undefined> {
  const images = await readTurnImages(client, email, sessionId, text);
  const sent = withAttachmentContext(
    text,
    await readTurnAttachmentContext(client, email, sessionId, text),
  );
  return images.length
    ? postOmnigentMessage(client, email, sessionId, sent, images)
    : postOmnigentMessage(client, email, sessionId, sent);
}

async function runTurn(
  client: OmnigentClientConfig,
  email: string,
  sessionId: string,
  turnInput: string,
  iterator: AsyncIterator<{ type: string; [key: string]: unknown }>,
  steering: SteeringFeed | undefined,
): Promise<void> {
  type Step = IteratorResult<{ type: string; [key: string]: unknown }>;
  const first = iterator.next();
  await postTurn(client, email, sessionId, turnInput);

  const seen: string[] = [];
  /** Messages posted during the turn whose fate the engine has not reported yet. */
  const unresolved = new Set<string>();
  /** Messages the engine already reported taken (a report can beat the post's own response). */
  const settled = new Set<string>();
  /** Messages the engine said it holds for the next turn. */
  const queued = new Set<string>();
  let completedAt: number | undefined;
  let queuedTurnPending = false;
  let next: Promise<Step> | undefined = first;
  // The pending read is abandoned when the turn ends and the stream is aborted.
  first.catch(() => undefined);

  const forwardNewMessages = async () => {
    if (!steering) return;
    const claimed = await steering.claim(seen);
    for (const message of claimed) {
      seen.push(message.id);
      const itemId = await postTurn(client, email, sessionId, message.text);
      if (itemId && !settled.has(itemId)) unresolved.add(itemId);
      await steering.forwarded([message.id]);
    }
  };

  while (true) {
    if (!next) {
      next = iterator.next();
      next.catch(() => undefined);
    }
    const waitMs =
      completedAt === undefined || queuedTurnPending
        ? STEERING_POLL_MS
        : Math.max(0, completedAt + DELIVERY_GRACE_MS - Date.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = new Promise<"tick">((resolve) => {
      timer = setTimeout(() => resolve("tick"), waitMs);
    });
    const raced = await Promise.race([next, tick]);
    clearTimeout(timer);

    if (raced === "tick") {
      if (completedAt === undefined) {
        await forwardNewMessages();
      } else if (!queuedTurnPending) {
        getLogger().error("omnigent gateway: a message sent during the turn was never reported", {
          count: unresolved.size,
        });
        return;
      }
      continue;
    }
    next = undefined;
    if (raced.done) break;
    const event = raced.value;

    const delivery = deliveryOf(event);
    if (delivery) {
      if (delivery.delivered === "turn") queuedTurnPending = true;
      if (delivery.delivered === "queued") {
        queued.add(delivery.itemId);
      } else {
        settled.add(delivery.itemId);
        unresolved.delete(delivery.itemId);
        queued.delete(delivery.itemId);
      }
      if (completedAt !== undefined && unresolved.size === 0 && !queuedTurnPending) return;
      continue;
    }
    if (event.type === "response.created" && completedAt !== undefined) {
      // The next turn started: a queued message is running now.
      queuedTurnPending = true;
      completedAt = undefined;
      continue;
    }
    if (event.type === "response.completed") {
      if (unresolved.size === 0) return;
      // A message sent during the turn may still be waiting for the next one.
      completedAt = Date.now();
      // One the engine said it holds runs as the next turn, however soon that starts.
      queuedTurnPending = [...unresolved].some((id) => queued.has(id));
      continue;
    }
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
  getLogger().error("omnigent gateway: session stream ended before response.completed");
  throw new OmnigentTurnFailure(CHAT_UNAVAILABLE_MESSAGE);
}

export type { OmnigentClientConfig, OmnigentConnection };
