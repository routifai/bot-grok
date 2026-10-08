import type { ReplyCardBlock, ThreadMessage } from "@nova/contracts";

/** What one card block in the transcript should draw. */
export type ResolvedReplyCard = {
  /** `null` hides it: a later card with the same `id` updates the first one in place. */
  block: ReplyCardBlock | null;
  /** The person's reply to the message holding this card (an `ask` card locks on it). */
  answer?: string;
};

export const replyCardKey = (messageId: string, blockIndex: number) => `${messageId}:${blockIndex}`;

function firstText(message: ThreadMessage): string {
  for (const block of message.blocks) if (block.kind === "text") return block.text.trim();
  return "";
}

/**
 * Resolves every reply card in `messages` (oldest first):
 * - cards sharing an `id` collapse into the first one's position, showing the latest settled
 *   data (a still-pending update never replaces a finished card with a skeleton);
 * - the person's next message after a card is its answer.
 */
export function resolveReplyCards(
  messages: readonly ThreadMessage[],
): Map<string, ResolvedReplyCard> {
  const latest = new Map<string, ReplyCardBlock>();
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.kind !== "reply_card" || !block.id) continue;
      const current = latest.get(block.id);
      if (!current || !block.pending || current.pending) latest.set(block.id, block);
    }
  }

  const resolved = new Map<string, ResolvedReplyCard>();
  const seen = new Set<string>();
  const unanswered: string[] = [];
  const answers = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "user") {
      const text = firstText(message);
      for (const key of unanswered.splice(0)) answers.set(key, text);
    }
    message.blocks.forEach((block, index) => {
      if (block.kind !== "reply_card") return;
      const key = replyCardKey(message.id, index);
      if (message.role !== "user") unanswered.push(key);
      if (!block.id) {
        resolved.set(key, { block });
      } else if (seen.has(block.id)) {
        resolved.set(key, { block: null });
      } else {
        seen.add(block.id);
        resolved.set(key, { block: latest.get(block.id) ?? block });
      }
    });
  }
  for (const [key, answer] of answers) {
    const entry = resolved.get(key);
    if (entry) resolved.set(key, { ...entry, answer });
  }
  return resolved;
}
