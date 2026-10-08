// The engine's transcript page -> Nova's `ThreadMessagePage`. Mechanical only: snake_case to
// camelCase and engine block types onto the chat's existing block types. Every rule (de-duping,
// dropping system notices, hiding a Side Chat's copied context, error codes) is the engine's
// (engine/omnigent/omnigent/superchat/transcript/). The wording of the file and secure-entry
// fallbacks is Nova's.
import type {
  MessageBlock,
  MessageFork,
  ReplyCardBlock,
  ThreadMessage,
  ThreadMessagePage,
} from "@nova/contracts";
import type {
  OmnigentTranscriptBlock,
  OmnigentTranscriptFork,
  OmnigentTranscriptPage,
} from "./client/transcript.js";

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
    case "fork_summary":
      return {
        kind: "fork_summary",
        forkId: block.fork_id,
        anchorItemId: block.anchor_item_id,
        title: block.title ?? "",
        summary: block.summary,
      };
  }
}

function mapFork(fork: OmnigentTranscriptFork): MessageFork {
  return {
    chatId: fork.session_id,
    title: fork.title ?? "",
    replies: fork.replies,
    live: fork.live,
    unread: fork.unread,
    state: fork.state,
    summary: fork.summary,
    createdAt: epochSecondsToIso(fork.created_at),
  };
}

/** One transcript page for chat `chatId`. The engine has already redacted its secrets. */
export function mapTranscriptPage(chatId: string, page: OmnigentTranscriptPage): ThreadMessagePage {
  const messages: ThreadMessage[] = page.data.map((message, seq) => ({
    id: message.id,
    threadId: chatId,
    seq,
    role: message.role === "assistant" ? "bot" : "user",
    blocks: message.blocks.map(mapBlock),
    createdAt: epochSecondsToIso(message.created_at),
    ...(message.forks ? { forks: message.forks.map(mapFork) } : {}),
  }));
  return {
    threadId: chatId,
    messages,
    olderCursor: null,
    olderItemCursor: page.has_more ? page.older_cursor : null,
    ...(page.lineage
      ? {
          lineage: {
            rootId: page.lineage.root_id,
            parentId: page.lineage.parent_id,
            anchorItemId: page.lineage.anchor_item_id ?? null,
          },
        }
      : {}),
    ...(page.live === undefined ? {} : { running: page.live }),
    ...(page.reset
      ? {
          reset: {
            itemId: page.reset.item_id,
            createdAt: epochSecondsToIso(page.reset.created_at),
          },
        }
      : { reset: null }),
  };
}
