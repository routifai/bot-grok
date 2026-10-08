/** The Conversation's two layouts: a start page while it is empty, the thread once it isn't. */
export type ConversationLayout = "start" | "thread";

/**
 * Whether the Conversation shows its start page (docs/muse/DESIGN.md "Conversation"): the
 * Muse's own Conversation, loaded, with no messages and nothing running. Anything else (still
 * loading, a group, a first message on its way) is the thread with the composer docked.
 */
export function conversationLayout(input: {
  museMode: boolean;
  hasMuse: boolean;
  /** False until the first transcript page has loaded. */
  loaded: boolean;
  messageCount: number;
  running: boolean;
}): ConversationLayout {
  return input.museMode &&
    input.hasMuse &&
    input.loaded &&
    input.messageCount === 0 &&
    !input.running
    ? "start"
    : "thread";
}
