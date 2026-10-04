// "The Muse speaks first" (docs/super-chat/README.md, WIRING.md slice A1): when a Helper's
// Result wakes the Super Chat and Omnigent answers on its own — nobody in Nova sent a message
// for that turn — this copies the assistant text into the Muse's Nova thread so it shows up in
// the Conversation without anyone having to ask. Runs on a recurring reconciliation tick
// (apps/worker, see job-reconciler.ts's `reconcileCloudAgents`/`reconcileComputerUpdates` for
// the same pattern) rather than a job per turn, since there is no event that fires when
// Omnigent speaks unprompted.
//
// Dedup with the normal run path (./gateway.ts): every Super Chat turn that *did* go through
// `runTurnOnOmnigent` already stamps `OmnigentSession.lastMirroredItemId` to that turn's last
// item id right after finishing. This job only ever looks at items strictly after that cursor,
// so a reply the run path just delivered is never re-posted here — and advances the cursor
// itself, per item, as it mirrors, so a crash mid-scan re-processes at most one item next tick.
import type { MessageBlock } from "@aiden/contracts";
import { containsSecret, redactSecrets } from "@aiden/core";
import type { PrismaClient, ThreadEvents } from "@aiden/db";
import { getLogger } from "@aiden/logging";
import {
  isRenderCardCall,
  redactReplyCard,
  replyCardFromToolCall,
  toolOutputsByCallId,
} from "./cards.js";
import {
  isSessionNotFoundError,
  isStaleCursorError,
  listOmnigentSessionItems,
  type OmnigentClientConfig,
} from "./client.js";
import { DEFAULT_OMNIGENT_SUPERCHAT_CONFIG, type OmnigentSuperChatConfig } from "./env.js";
import { extractAssistantText } from "./gateway.js";

/** Distinguishes a mirrored message's synthetic Run from every other trigger
 * (packages/contracts/src/domain.ts RunSchema.trigger) — see ./mirror.ts's module doc. */
export const MIRROR_RUN_TRIGGER = "omnigent_mirror";

export interface OmnigentMirrorDeps {
  prisma: PrismaClient;
  events: ThreadEvents;
  client: OmnigentClientConfig;
  /** Secret values redacted from a mirrored message before it is persisted — same list
   * ./gateway.ts redacts the normal run path's reply with. */
  secrets: string[];
  /** Attributed as the synthetic Run's lease owner, like every other background job. */
  workerId: string;
  /** Settings documented in docs/super-chat/README.md's Settings table
   * (./env.ts#omnigentSuperChatConfigFromEnv). Defaults apply when omitted, so existing
   * callers/tests that construct deps by hand keep today's behavior unchanged. */
  config?: OmnigentSuperChatConfig;
}

interface MirrorSessionRow {
  botId: string;
  omnigentSessionId: string;
  lastMirroredItemId: string | null;
}

/** Scans every bot with recent Super Chat activity for items Omnigent produced on its own since
 * the last mirror/turn, and copies each one into the Muse's Nova thread. One session's failure
 * (a transient Omnigent/DB error) is logged and never blocks the rest. */
export async function reconcileOmnigentMirror(deps: OmnigentMirrorDeps): Promise<void> {
  const config = deps.config ?? DEFAULT_OMNIGENT_SUPERCHAT_CONFIG;
  const sessions: MirrorSessionRow[] = await deps.prisma.omnigentSession.findMany({
    where: { updatedAt: { gte: new Date(Date.now() - config.mirrorLookbackMs) } },
    select: { botId: true, omnigentSessionId: true, lastMirroredItemId: true },
  });
  for (const session of sessions) {
    await mirrorOneSuperChat(deps, session, config).catch((error) =>
      getLogger().error("omnigent mirror: failed for one Super Chat, continuing", error, {
        botId: session.botId,
      }),
    );
  }
}

async function mirrorOneSuperChat(
  deps: OmnigentMirrorDeps,
  session: MirrorSessionRow,
  config: OmnigentSuperChatConfig,
): Promise<void> {
  const bot = await deps.prisma.bot.findUnique({
    where: { id: session.botId },
    select: { id: true, spaceId: true, userId: true, thread: { select: { id: true } } },
  });
  // No private Conversation thread yet (shouldn't happen once a Super Chat session exists, but
  // a Muse mid-deletion or a thread the user cleared differently is not this job's problem).
  if (!bot || !bot.thread) return;
  const thread = bot.thread;
  // A turn the person started is still in flight: its reply may already be in Omnigent but not
  // yet stamped as delivered by the run path, so wait for it rather than post it twice.
  const activeRun = await deps.prisma.run.findFirst({
    where: {
      botId: bot.id,
      threadId: thread.id,
      status: { in: ["queued", "running"] },
      NOT: { trigger: MIRROR_RUN_TRIGGER },
    },
    select: { id: true },
  });
  if (activeRun) return;
  const user = await deps.prisma.user.findUnique({
    where: { id: bot.userId },
    select: { email: true },
  });
  if (!user) return;

  let page: Awaited<ReturnType<typeof listOmnigentSessionItems>>;
  try {
    page = await listOmnigentSessionItems(deps.client, user.email, session.omnigentSessionId, {
      after: session.lastMirroredItemId ?? undefined,
      order: "asc",
      limit: config.mirrorPageSize,
    });
  } catch (error) {
    // The cursor names an item that no longer exists (deleted, or archived out of the
    // filtered set) — enumeration cannot continue from it. Reset to null and log once; the
    // next tick restarts this Super Chat's scan from the beginning rather than getting stuck
    // retrying the same stale cursor forever (docs/super-chat/WIRING.md review item 1).
    if (isStaleCursorError(error)) {
      getLogger().error("omnigent mirror: stale cursor, resetting and retrying next tick", {
        botId: bot.id,
      });
      await deps.prisma.omnigentSession.update({
        where: { botId: session.botId },
        data: { lastMirroredItemId: null },
      });
      return;
    }
    // The engine no longer has this session; the next turn recreates it.
    if (isSessionNotFoundError(error)) return;
    throw error;
  }

  const outputs = toolOutputsByCallId(page.data);
  for (const item of page.data) {
    if (isRenderCardCall(item)) {
      const callId = typeof item.call_id === "string" ? item.call_id : "";
      // Its output may land on the next page: wait for it rather than skip the card.
      if (!outputs.has(callId)) break;
      const card = replyCardFromToolCall(item, outputs.get(callId));
      if (card) {
        const block = redactReplyCard(card, deps.secrets);
        if (containsSecret(block, deps.secrets)) {
          getLogger().error("omnigent mirror: refusing to mirror a card containing a secret", {
            botId: bot.id,
          });
        } else {
          await mirrorAssistantMessage(deps, bot, thread.id, [block]);
        }
      }
    } else if (item.type === "message" && item.role === "assistant") {
      const text = extractAssistantText([item]);
      if (text) {
        const redacted = redactSecrets(text, deps.secrets);
        if (containsSecret(redacted, deps.secrets)) {
          getLogger().error("omnigent mirror: refusing to mirror a message containing a secret", {
            botId: bot.id,
          });
        } else {
          await mirrorAssistantMessage(deps, bot, thread.id, [{ kind: "text", text: redacted }]);
        }
      }
    }
    // Advance the cursor past this item regardless of whether it was mirrored (a tool-call
    // item, or an empty-text one) — committed per item so a crash mid-page re-scans at most
    // the one item it died on, never re-posts an already-mirrored message.
    await deps.prisma.omnigentSession.update({
      where: { botId: session.botId },
      data: { lastMirroredItemId: item.id },
    });
  }
}

/** Posts one Omnigent-initiated assistant message into `bot`'s Nova thread through the same
 * `ThreadEvents.finalizeRun` primitive every other engine path uses to post an assistant
 * message (./gateway.ts's own `runTurnOnOmnigent`) — not a new message store: a synthetic,
 * already-"running" Task/Run/Attempt exists only so `finalizeRun` has something to finalize. */
async function mirrorAssistantMessage(
  deps: OmnigentMirrorDeps,
  bot: { id: string; spaceId: string; userId: string },
  threadId: string,
  blocks: MessageBlock[],
): Promise<void> {
  const task = await deps.prisma.task.create({
    data: {
      spaceId: bot.spaceId,
      botId: bot.id,
      threadId,
      userId: bot.userId,
      prompt: "The Muse spoke on its own (a Helper's result).",
      status: "running",
    },
  });
  const run = await deps.prisma.run.create({
    data: {
      spaceId: bot.spaceId,
      botId: bot.id,
      threadId,
      taskId: task.id,
      userId: bot.userId,
      status: "running",
      trigger: MIRROR_RUN_TRIGGER,
      leaseOwner: deps.workerId,
      leaseFence: 0,
      startedAt: new Date(),
    },
  });
  const attempt = await deps.prisma.attempt.create({
    data: { runId: run.id, fence: 0, status: "running" },
  });
  const completed = await deps.events.finalizeRun({
    spaceId: bot.spaceId,
    threadId,
    botId: bot.id,
    runId: run.id,
    taskId: task.id,
    attemptId: attempt.id,
    leaseOwner: deps.workerId,
    leaseFence: 0,
    outcome: "completed",
    blocks,
    markUnread: true,
  });
  if (!completed) {
    getLogger().error("omnigent mirror: finalizeRun did not apply", {
      botId: bot.id,
      runId: run.id,
    });
  }
}
