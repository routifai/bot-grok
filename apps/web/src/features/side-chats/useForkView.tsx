import type { ChatSummary, MessageFork, ThreadMessage } from "@nova/contracts";
import { type RefObject, useCallback, useMemo, useState } from "react";
import { type ForkThreadTarget, forkTarget } from "./ForkThread";
import { ForkUnderMessage } from "./ForkUnderMessage";
import { type ForkFilter, type ForkRow, forkRows } from "./forkModel";
import type { ChatListState } from "./useChatList";

/** How long a jumped-to message keeps its flash. */
const FLASH_MS = 1400;
/** Lets a smooth jump scroll settle before the flash plays. */
const FLASH_DELAY_MS = 350;

/** Flashes a message of the scrolled transcript once (styles.css `[data-fork-flash]`). */
export function flashMessage(scroller: HTMLElement | null, messageId: string) {
  const row = scroller?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`);
  if (!row) return;
  row.removeAttribute("data-fork-flash");
  void row.offsetWidth;
  row.setAttribute("data-fork-flash", "");
  window.setTimeout(() => row.removeAttribute("data-fork-flash"), FLASH_MS);
}

/**
 * The Conversation's fork UI state (ADR 0010): the Chat or Forks view and its filter, the "lift
 * and ask" focus, and the fork open in the thread view, with the moves between them. Shell.tsx
 * owns the transcript and the chat list; this only decides what is open.
 */
export function useForkView({
  chatList,
  messages,
  scrollRef,
  reveal,
  scrollToMessage,
}: {
  chatList: ChatListState;
  /** The Conversation as loaded (engine messages carry their forks). */
  messages: readonly ThreadMessage[] | null;
  scrollRef: RefObject<HTMLElement | null>;
  /** Pages the Conversation back until the message is loaded. */
  reveal: (messageId: string) => Promise<boolean>;
  scrollToMessage: (messageId: string) => void;
}) {
  const [view, setView] = useState<"chat" | "forks">("chat");
  const [filter, setFilter] = useState<ForkFilter>("all");
  const [ask, setAsk] = useState<{ anchor: ThreadMessage; chatId: string | null } | null>(null);
  const [thread, setThread] = useState<ForkThreadTarget | null>(null);

  const rows = useMemo(
    () => forkRows(chatList.status === "ready" ? chatList.chats : [], messages ?? []),
    [chatList, messages],
  );

  /** Scrolls the Conversation to a message (paging back to it first) and flashes it. */
  const jump = useCallback(
    (messageId: string) => {
      void reveal(messageId).then((found) => {
        if (!found) return;
        scrollToMessage(messageId);
        window.setTimeout(() => flashMessage(scrollRef.current, messageId), FLASH_DELAY_MS);
      });
    },
    [reveal, scrollRef, scrollToMessage],
  );

  const openFork = useCallback((target: ForkThreadTarget) => {
    setAsk(null);
    setView("chat");
    setThread(target);
  }, []);

  const openForkOf = useCallback(
    (fork: MessageFork, anchor: ThreadMessage) => openFork(forkTarget(fork, anchor)),
    [openFork],
  );

  /** A fork from the sidebar or the All forks list: over its message, scrolled into place. */
  const openRow = useCallback(
    (row: ForkRow) => {
      const anchor = messages?.find((message) => message.id === row.anchorItemId) ?? null;
      openFork({
        chat: {
          id: row.chatId,
          title: row.title,
          live: row.status === "live",
          unread: row.unread,
          archived: row.status === "archived",
        },
        anchor,
      });
      // An anchor further back is paged in by the thread view once it knows the anchor is in
      // the Conversation (`revealAnchor`), not here: a fork of a fork's anchor is not.
      if (anchor) scrollToMessage(anchor.id);
    },
    [messages, openFork, scrollToMessage],
  );

  /** The open fork's anchor is in the Conversation but not loaded: page back to it. */
  const revealAnchor = useCallback(
    (anchorItemId: string) => {
      void reveal(anchorItemId).then((found) => {
        if (found) scrollToMessage(anchorItemId);
      });
    },
    [reveal, scrollToMessage],
  );

  const closeThread = useCallback(() => {
    setThread((current) => {
      const anchorId = current?.anchor?.id;
      if (anchorId) window.setTimeout(() => flashMessage(scrollRef.current, anchorId), 60);
      return null;
    });
  }, [scrollRef]);

  /** The open fork was restored: its thread view shows it as an open, writable fork. */
  const markRestored = useCallback((chatId: string) => {
    setThread((current) =>
      current?.chat.id === chatId
        ? { ...current, chat: { ...current.chat, archived: false } }
        : current,
    );
  }, []);

  const startAsk = useCallback((anchor: ThreadMessage, chatId: string | null = null) => {
    setAsk({ anchor, chatId });
  }, []);

  /** The fork the ask focus just opened: straight into its thread, its first message shown. */
  const created = useCallback(
    (chat: ChatSummary, text: string) => {
      const anchor = ask?.anchor ?? null;
      setAsk(null);
      setThread({
        chat: { id: chat.id, title: chat.title, live: true, unread: false, archived: false },
        anchor,
        firstText: text,
        firstFailed: Boolean(chat.firstMessageErrorCode),
      });
    },
    [ask],
  );

  const showForks = useCallback((next: ForkFilter) => {
    setFilter(next);
    setThread(null);
    setAsk(null);
    setView("forks");
  }, []);

  /** Everything closed: leaving the Conversation, or opening a full-size side chat. */
  const reset = useCallback(() => {
    setThread(null);
    setAsk(null);
    setView("chat");
  }, []);

  const renderUnder = useCallback(
    (message: ThreadMessage) => (
      <ForkUnderMessage
        message={message}
        onOpenFork={openForkOf}
        onNewFork={message.forks !== undefined ? startAsk : undefined}
      />
    ),
    [openForkOf, startAsk],
  );

  return {
    rows,
    view,
    setView,
    filter,
    setFilter,
    ask,
    setAsk,
    thread,
    openFork,
    openRow,
    closeThread,
    markRestored,
    startAsk,
    created,
    showForks,
    reset,
    jump,
    revealAnchor,
    renderUnder,
  };
}

/** A fork as the full-size side chat view reads it: the list's entry, or one built from what
 * the thread view knows. */
export function forkChatSummary(
  chat: ForkThreadTarget["chat"],
  chatList: ChatListState,
): ChatSummary {
  const listed = chatList.status === "ready" ? chatList.chats.find((c) => c.id === chat.id) : null;
  return (
    listed ?? {
      id: chat.id,
      title: chat.title,
      start: "withContext",
      summary: null,
      archived: chat.archived,
      live: chat.live,
      unread: chat.unread,
      updatedAt: new Date().toISOString(),
    }
  );
}
