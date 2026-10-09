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
import {
  adoptOmnigentMuse,
  getOmnigentMuse,
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
    await sendTurnAndAwaitCompletion(client, user.email, sessionId, turnInput, config);

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

/**
 * Posts the turn's message, then reads the live stream until `response.completed`, so the run
 * tracks the turn (working row, stop, failure). The reply itself is not kept here: the engine's
 * transcript holds it (ADR 0009). The GET stream request is started (its body opened) before the
 * POST so a fast reply cannot race ahead of the listener — see
 * engine/omnigent/omnigent/server/API.md's "Reconnect Contract" note on opening the stream first.
 */
async function sendTurnAndAwaitCompletion(
  client: OmnigentClientConfig,
  email: string,
  sessionId: string,
  turnInput: string,
  config: OmnigentSuperChatConfig,
): Promise<void> {
  const signal = AbortSignal.timeout(config.turnTimeoutMs);
  const iterator = streamOmnigentSession(client, email, sessionId, signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  const images = await readTurnImages(client, email, sessionId, turnInput);
  // The message goes as the person wrote it (their words and the attachment reference lines).
  // The Computer reads the referenced files when the turn starts and puts their framed text in
  // front of the message for the model only; it is never part of the stored message.
  const sent = turnInput;
  if (images.length) await postOmnigentMessage(client, email, sessionId, sent, images);
  else await postOmnigentMessage(client, email, sessionId, sent);

  let step = await first;
  while (!step.done) {
    const event = step.value;
    if (event.type === "response.completed") return;
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
    step = await iterator.next();
  }
  getLogger().error("omnigent gateway: session stream ended before response.completed");
  throw new OmnigentTurnFailure(CHAT_UNAVAILABLE_MESSAGE);
}

export type { OmnigentClientConfig, OmnigentConnection };
