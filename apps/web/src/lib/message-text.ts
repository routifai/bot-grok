import type { ThreadMessage } from "@nova/contracts";
import { parseAttachmentReferences } from "@nova/core";
import { messageProviderLabel } from "./messaging";

/** What a person's own text shows as outside the Conversation view (a side chat, the Activity
 * panel, a copy): their words, with the attachment reference lines as one "Attached: ..." line.
 * A block of document text an older gateway stored with the message is never part of it. */
export function personText(text: string): string {
  const { attachments, caption } = parseAttachmentReferences(text);
  if (attachments.length === 0) return text;
  const names = attachments.map((a) => a.path.split("/").pop() ?? a.path).join(", ");
  return [`Attached: ${names}`, caption].filter(Boolean).join("\n");
}

/** Plain message text for clipboard copy — text/ask/progress only, no chrome. */
export function copyableMessageText(message: ThreadMessage): string {
  return message.blocks
    .map((block) => {
      if (block.kind === "channel_message") {
        return `${messageProviderLabel(block.provider, block.transport)} · ${block.fromLabel}: ${block.text}`;
      }
      if (block.kind === "text") {
        return message.role === "user" ? personText(block.text) : block.text;
      }
      if (block.kind === "progress" || block.kind === "ask") return block.text;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}
