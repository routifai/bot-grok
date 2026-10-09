import type { ThreadMessage, ThreadMessagePage } from "@nova/contracts";

const epochSeconds = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

/** The newest transcript page merged into what is loaded. Older pages already loaded stay when
 * the new page overlaps them; otherwise (a long gap) the new page stands alone. */
export function mergeNewestTranscriptPage(
  loaded: { messages: ThreadMessage[]; olderCursor: string | null } | null,
  page: ThreadMessagePage,
): { threadId: string; messages: ThreadMessage[]; olderCursor: string | null } {
  const newest = page.messages;
  const fresh = {
    threadId: page.threadId,
    messages: newest,
    olderCursor: page.olderItemCursor ?? null,
  };
  const first = newest[0];
  if (!loaded || !first) return fresh;
  const overlap = loaded.messages.findIndex((message) => message.id === first.id);
  if (overlap === -1) return fresh;
  return {
    threadId: page.threadId,
    messages: [...loaded.messages.slice(0, overlap), ...newest],
    olderCursor: loaded.olderCursor,
  };
}

/** The person's messages Nova has accepted that the engine's transcript does not show yet: the
 * send is acknowledged at once, the engine records it a moment later. Anything not newer than
 * the transcript's last message is already in it (the engine stamps whole seconds). */
export function pendingUserMessages(
  accepted: readonly ThreadMessage[],
  transcript: readonly ThreadMessage[],
): ThreadMessage[] {
  const last = transcript.at(-1);
  const lastSeconds = last ? epochSeconds(last.createdAt) : -1;
  return accepted.filter(
    (message) => message.role === "user" && epochSeconds(message.createdAt) > lastSeconds,
  );
}

/** A quoted passage as a markdown blockquote above what the person wrote. */
export function quotedMessageText(quote: string, text: string): string {
  const block = quote
    .trim()
    .split("\n")
    .map((line) => `> ${line}`.trimEnd())
    .join("\n");
  return text ? `${block}\n\n${text}` : block;
}

/** The block kinds the engine's transcript itself produces (plus the legacy reply shapes Nova
 * once stored). A Nova thread row made only of these is a copy of engine content. */
const ENGINE_BLOCK_KINDS: ReadonlySet<string> = new Set([
  "text",
  "reply_card",
  "helper",
  "error",
  "progress",
  "steps",
  "file",
  "image",
]);

/**
 * The Conversation as shown: the engine's transcript, plus Nova's own thread rows, by time.
 *
 * These rows are Nova-owned, not engine behaviour: cards and notices Nova writes into the
 * Muse's thread itself (a taught-skill draft, an app-connect card, a messaging notice, a
 * Muse-to-Muse marker). The engine knows nothing of them, so they are layered in here, purely
 * for display. Nova's copies of the person's messages and of replies are left out (the
 * transcript is the source), except a message accepted but not yet recorded by the engine.
 */
export function conversationMessages(
  engine: readonly ThreadMessage[],
  novaThread: readonly ThreadMessage[],
): ThreadMessage[] {
  // Rows older than what is loaded wait until "Load earlier" reaches them.
  const from = engine[0] ? epochSeconds(engine[0].createdAt) : Number.NEGATIVE_INFINITY;
  const novaOwned = novaThread.filter(
    (message) =>
      message.blocks.some((block) => !ENGINE_BLOCK_KINDS.has(block.kind)) &&
      epochSeconds(message.createdAt) >= from,
  );
  const extra = new Map<string, ThreadMessage>();
  for (const message of [...novaOwned, ...pendingUserMessages(novaThread, engine)]) {
    extra.set(message.id, message);
  }
  // Array.sort is stable: on a tie the engine's message stays first.
  return [...engine, ...extra.values()].sort(
    (a, b) => epochSeconds(a.createdAt) - epochSeconds(b.createdAt),
  );
}
