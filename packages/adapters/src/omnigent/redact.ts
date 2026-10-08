// Redaction for the Omnigent read paths the engine does not redact itself. The engine redacts
// what it knows (secret-named env vars, vault values) on the transcript, items, search, related
// chats, activities, feed and asks (ADR 0009), so those paths pass through untouched. What stays
// here, built on the same `redactSecrets` primitive over `omnigentRedactionSecretsFromEnv`:
// the Goal log (`redactThreadMessages`, objective runs) and `memory.profile`/claims/daily notes
// (`redactMemoryProfile`), neither of which the engine redacts.
import type { ThreadMessage } from "@nova/contracts";
import { redactSecrets } from "@nova/core";
import { redactReplyCard } from "./cards.js";

function redactString(value: string, secrets: string[]): string {
  return secrets.length === 0 ? value : redactSecrets(value, secrets);
}

/** The Goal log: redacts every `text` block's text, every Helper row's title and every
 * card (one holding a secret degrades to its redacted fallback, ./cards.ts). */
export function redactThreadMessages(
  messages: ThreadMessage[],
  secrets: string[],
): ThreadMessage[] {
  if (secrets.length === 0) return messages;
  return messages.map((message) => ({
    ...message,
    blocks: message.blocks.map((block) =>
      block.kind === "text"
        ? { ...block, text: redactString(block.text, secrets) }
        : block.kind === "helper"
          ? { ...block, title: redactString(block.title, secrets) }
          : block.kind === "reply_card"
            ? redactReplyCard(block, secrets)
            : block,
    ),
  }));
}

/** `memory.profile`: redacts the Memory Profile text itself. */
export function redactMemoryProfile(profile: string | null, secrets: string[]): string | null {
  if (profile === null || secrets.length === 0) return profile;
  return redactString(profile, secrets);
}
