// The engine's transcript page -> Nova's `ThreadMessagePage`. Mechanical only: snake_case to
// camelCase and engine block types onto the chat's existing block types. Every rule (de-duping,
// dropping system notices, hiding a Side Chat's copied context, error codes) is the engine's
// (engine/omnigent/omnigent/superchat/transcript/). The wording of the file and secure-entry
// fallbacks is Nova's.
import type {
  MessageBlock,
  ReplyCardBlock,
  ThreadMessage,
  ThreadMessagePage,
} from "@aiden/contracts";
import type { OmnigentTranscriptBlock, OmnigentTranscriptPage } from "./client/transcript.js";
import { redactThreadMessages } from "./redact.js";

function epochSecondsToIso(epochSeconds: number | null | undefined): string {
  return new Date((epochSeconds ?? 0) * 1000).toISOString();
}

function fileCard(block: Extract<OmnigentTranscriptBlock, { type: "file" }>): ReplyCardBlock {
  const label = block.title || block.name;
  const revision = block.version && block.version > 1 ? ` (version ${block.version})` : "";
  return {
    kind: "reply_card",
    card: "file",
    id: `artifact:${block.artifact_id}`,
    data: {
      name: block.name,
      artifactId: block.artifact_id,
      ...(block.kind ? { kind: block.kind } : {}),
      ...(block.size !== undefined ? { size: block.size } : {}),
      ...(block.version !== undefined ? { version: block.version } : {}),
      ...(block.versions !== undefined ? { versions: block.versions } : {}),
    },
    fallback: `Saved **${label}**${revision}. Open it in Nova's Library.`,
  };
}

function secureEntryCard(
  block: Extract<OmnigentTranscriptBlock, { type: "secure_entry" }>,
): ReplyCardBlock {
  return {
    kind: "reply_card",
    card: "secure_entry",
    data: {
      requestId: block.request_id,
      name: block.name,
      site: block.site,
      ...(block.reason ? { reason: block.reason } : {}),
    },
    fallback: `Nova needs a login for ${block.site}. Open this chat in Nova to enter it securely.`,
  };
}

function mapBlock(block: OmnigentTranscriptBlock): MessageBlock {
  switch (block.type) {
    case "text":
      return { kind: "text", text: block.text };
    case "card":
      return {
        kind: "reply_card",
        card: block.card.card,
        ...(block.card.id ? { id: block.card.id } : {}),
        ...(block.card.title ? { title: block.card.title } : {}),
        data: block.card.data,
        fallback: block.card.fallback,
        ...(block.pending ? { pending: true } : {}),
      };
    case "helper":
      return { kind: "helper", helperId: block.session_id, title: block.title };
    case "file":
      return fileCard(block);
    case "secure_entry":
      return secureEntryCard(block);
    case "error":
      return { kind: "error", code: block.code, ...(block.level ? { level: block.level } : {}) };
  }
}

/** One transcript page for chat `chatId`, redacted with `secrets`. `running` is the chat's own
 * live flag (the related-chats list carries it; the transcript does not). */
export function mapTranscriptPage(
  chatId: string,
  page: OmnigentTranscriptPage,
  secrets: string[],
  running?: boolean,
): ThreadMessagePage {
  const messages: ThreadMessage[] = page.data.map((message, seq) => ({
    id: message.id,
    threadId: chatId,
    seq,
    role: message.role === "assistant" ? "bot" : "user",
    blocks: message.blocks.map(mapBlock),
    createdAt: epochSecondsToIso(message.created_at),
  }));
  return {
    threadId: chatId,
    messages: redactThreadMessages(messages, secrets),
    olderCursor: null,
    olderItemCursor: page.has_more ? page.older_cursor : null,
    ...(running === undefined ? {} : { running }),
  };
}
