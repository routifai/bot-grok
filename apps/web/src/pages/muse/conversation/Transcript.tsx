import { i18n } from "@lingui/core";
import { useLingui } from "@lingui/react/macro";
import type { MessageReaction, ThreadMessage } from "@nova/contracts";
import { isPeerReceiptBlocks, isToolActivityBlock, projectMessageReactions } from "@nova/core";
import { cn, type GroupAvatarMember } from "@nova/ui-web";
import { ArrowDown } from "lucide-react";
import {
  type ComponentProps,
  memo,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ActiveBotGlyph } from "../../../components/ai/CollaborationMarker";
import {
  ReplyCardBotProvider,
  ReplyCardSendProvider,
  ReplyCardThreadProvider,
} from "../../../components/cards/context";
import { forkAnchorFor } from "../../../features/side-chats/forkModel";
import type { ArtifactTarget } from "../../../lib/artifact-open";
import { quoteDraftForSelection } from "../../../lib/quote-selection";
import { transcriptIsNearEnd, transcriptMovedDown } from "../../../lib/transcript-scroll";
import { type MuseLiveRun, useMuseLiveState } from "../chrome/useMuseLiveState";
import { FailureRun } from "./FailureNote";
import type { TranscriptRow } from "./failureNotes";
import { foldFailureRuns } from "./failureNotes";
import { MessageHoverActions } from "./MessageHoverActions";
import { MessageView } from "./MessageView";
import { hasOpenMuseAsk } from "./messageText";
import { QuoteSelectionButton } from "./QuoteSelectionButton";
import { WorkingRow } from "./WorkingRow";

/** The transcript, with its reply cards resolved across the whole thread (in-place updates,
 * answered asks). */
export function Transcript({
  onSendCard,
  ...props
}: ComponentProps<typeof TranscriptView> & {
  /** A reply card's button sends this text as the person's next message. */
  onSendCard?: (text: string) => void;
}) {
  const view = (
    <ReplyCardBotProvider
      botId={
        props.artifactTarget && "botId" in props.artifactTarget
          ? props.artifactTarget.botId
          : undefined
      }
    >
      <ReplyCardThreadProvider messages={props.messages}>
        <TranscriptView {...props} />
      </ReplyCardThreadProvider>
    </ReplyCardBotProvider>
  );
  return onSendCard ? (
    <ReplyCardSendProvider send={onSendCard}>{view}</ReplyCardSendProvider>
  ) : (
    view
  );
}

const TranscriptView = memo(function Transcript({
  museMode,
  museFace,
  botDisplayName,
  museRuns,
  leading,
  trailing,
  followSignal,
  scrollRef,
  scrollRequest,
  onScrollRequestHandled,
  artifactTarget,
  messages,
  olderCursor,
  loadingOlder,
  answerableAskMessageId,
  running,
  workingBots,
  onLoadOlder,
  onShowEarlier,
  onOpenBot,
  onAnswer,
  onReply,
  onQuote,
  onReact,
  onJumpToMessage,
  onOpenPeerMessages,
  memberName,
  peerBot,
  onRefresh,
  onBotChanged,
  onAddRoutine,
  voiceReady,
  speakingMessageId,
  onSpeak,
  onOpenComputer,
  onFork,
  renderUnder,
  aside,
}: {
  museMode?: boolean;
  /** Muse mode: the face shown beside the Muse's replies. */
  museFace?: { color: string; identity: string };
  /** Muse mode: the Muse's own name, for first-run hint copy (`FirstRunHint`). */
  botDisplayName?: string;
  /** Muse mode: the active bot's live runs, for the gutter face and bottom-of-transcript row. */
  museRuns?: readonly MuseLiveRun[];
  /** Rendered at the top of the scrolling column, before the messages. */
  leading?: ReactNode;
  /** Rendered at the bottom of the scrolling column, after the messages. */
  trailing?: ReactNode;
  /** Changes when the person sends: follow the tail again. */
  followSignal?: number;
  scrollRef: RefObject<HTMLDivElement | null>;
  scrollRequest: { messageId: string; nonce: number } | null;
  onScrollRequestHandled: () => void;
  artifactTarget: ArtifactTarget;
  messages: ThreadMessage[];
  olderCursor: number | string | null;
  loadingOlder: boolean;
  answerableAskMessageId: string | null;
  running: boolean;
  workingBots: GroupAvatarMember[];
  onLoadOlder: () => void | Promise<void>;
  /** The Conversation was cleared and its earlier history can be shown (the Muse only). */
  onShowEarlier?: () => void | Promise<void>;
  onOpenBot: (botId: string) => void;
  onAnswer: (message: ThreadMessage, text: string, username?: string) => Promise<void>;
  /** Without reply/quote handlers (a Side Chat has no reply threads) those actions are hidden. */
  onReply?: (message: ThreadMessage) => void;
  onQuote?: (message: ThreadMessage, quote: string) => void;
  onReact: (message: ThreadMessage, reaction: MessageReaction) => Promise<void>;
  onJumpToMessage: (messageId: string) => void;
  onOpenPeerMessages: (peer: { peerBotId: string; peerBotName: string }) => void;
  memberName?: (botId: string | undefined) => string | undefined;
  peerBot: (botId: string) => { color: string; status?: string } | undefined;
  onRefresh: () => Promise<void>;
  onBotChanged: () => Promise<void>;
  onAddRoutine: (name: string, prompt: string) => void;
  voiceReady: boolean;
  speakingMessageId: string | null;
  onSpeak: (message: ThreadMessage) => void;
  onOpenComputer: (botId?: string) => void;
  /** Fork a message (ADR 0010): offered on the messages the engine can anchor a fork to. */
  onFork?: (message: ThreadMessage) => void;
  /** Rendered under a message (its forks); return null for nothing. */
  renderUnder?: (message: ThreadMessage) => ReactNode;
  /** A strip beside the scrolling column, on the panel's end edge (the fork gutter). */
  aside?: ReactNode;
}) {
  const { t } = useLingui();
  const { label: museLiveLabel } = useMuseLiveState({
    botId: museFace?.identity ?? "",
    runs: museRuns ?? [],
    messages,
  });
  const [atEnd, setAtEnd] = useState(true);
  const following = useRef(true);
  const autoScrolling = useRef(false);
  const lastScrollTop = useRef<number | null>(null);
  const autoScrollTimer = useRef<number | undefined>(undefined);
  const jumpButtonRef = useRef<HTMLButtonElement>(null);
  const messageById = useMemo(
    () => new Map(messages.map((message) => [message.id, message])),
    [messages],
  );
  const reactionView = useMemo(() => projectMessageReactions(messages), [messages]);
  // Muse: failed replies in a row read as one "3 failed attempts" line (failureNotes.ts).
  const transcriptRows = useMemo<TranscriptRow[]>(
    () =>
      museMode
        ? foldFailureRuns(reactionView.visibleMessages)
        : reactionView.visibleMessages.map((message) => ({ kind: "message", message })),
    [museMode, reactionView.visibleMessages],
  );
  const workingBotName = workingBots.length === 1 ? workingBots[0]?.name : undefined;
  const workingLabel =
    workingBotName != null && workingBotName !== ""
      ? t`${workingBotName} is working`
      : t`Bots are working`;
  const [quoteDraft, setQuoteDraft] = useState<{
    message: ThreadMessage;
    text: string;
    range: Range;
  } | null>(null);
  const selectingWithMouse = useRef(false);

  const evaluateSelection = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      setQuoteDraft(null);
      return;
    }
    const range = selection.getRangeAt(0);
    const contentOf = (node: Node) =>
      (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(
        "[data-quote-message-id]",
      ) ?? null;
    const startContent = contentOf(range.startContainer);
    const endContent = contentOf(range.endContainer);
    // selection.toString() serializes the whole range (a Ctrl+A transcript is
    // unbounded), so it only runs once both endpoints sit in one message.
    const draft = quoteDraftForSelection(
      {
        startContent,
        endContent,
        text: startContent && startContent === endContent ? selection.toString() : "",
      },
      messageById,
    );
    setQuoteDraft((prev) => {
      if (!draft) return null;
      // Repeat firings for an unchanged selection reuse the draft so the
      // transcript isn't re-rendered by every unrelated selection event. A
      // moved selection (e.g. keyboard-selecting a second occurrence of the
      // same text) must carry its new Range — the pill anchors to it.
      if (
        prev &&
        prev.message === draft.message &&
        prev.text === draft.text &&
        prev.range.compareBoundaryPoints(Range.START_TO_START, range) === 0 &&
        prev.range.compareBoundaryPoints(Range.END_TO_END, range) === 0
      ) {
        return prev;
      }
      return { ...draft, range };
    });
  }, [messageById]);

  // Keyboard and assistive-tech selections never reach a mouseup, so the pill
  // lifecycle listens on selectionchange; the mouse flag keeps it hidden while
  // a drag is still in flight.
  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      selectingWithMouse.current = true;
      if ((event.target as Element | null)?.closest?.("[data-quote-selection]")) return;
      setQuoteDraft(null);
    };
    const onMouseUp = () => {
      selectingWithMouse.current = false;
      evaluateSelection();
    };
    const onSelectionChange = () => {
      if (!selectingWithMouse.current) evaluateSelection();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setQuoteDraft(null);
    };
    // A drag that ends outside the window never fires document mouseup; reset
    // the flag on blur so keyboard selections keep working afterwards.
    const onWindowBlur = () => {
      selectingWithMouse.current = false;
    };
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("mouseup", onMouseUp, true);
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      document.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("mouseup", onMouseUp, true);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [evaluateSelection]);
  const snapToEnd = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    following.current = true;
    autoScrolling.current = false;
    setAtEnd(true);
    element.scrollTo({ top: element.scrollHeight, behavior: "auto" });
  }, [scrollRef]);

  const jumpToLatest = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    following.current = true;
    autoScrolling.current = !reducedMotion;
    setAtEnd(true);
    element.scrollTo({
      top: element.scrollHeight,
      behavior: reducedMotion ? "auto" : "smooth",
    });
    window.clearTimeout(autoScrollTimer.current);
    // Fallback only: onScroll clears autoScrolling once near-end is reached.
    autoScrollTimer.current = window.setTimeout(
      () => {
        autoScrolling.current = false;
      },
      reducedMotion ? 0 : 2_000,
    );
  }, [scrollRef]);

  const scrolledJump = useRef<number | null>(null);
  const jumpScrolling = useRef(false);
  const jumpScrollTimer = useRef<number | undefined>(undefined);
  const endJumpScroll = useCallback(() => {
    jumpScrolling.current = false;
    window.clearTimeout(jumpScrollTimer.current);
    scrollRef.current?.removeEventListener("scrollend", endJumpScroll);
  }, [scrollRef]);
  // A jump scroll must win over follow-the-tail: unfollow inside the commit
  // that mounts the row so a live commit cannot cancel the animation, keep
  // retrying while the pinned window is still rendering, and suppress the
  // near-end follow re-arm only for the jump's own scroll events — scrollend
  // (or user input interrupting it, which also fires scrollend) ends the
  // suppression, with the timeout as fallback when no scroll happens.
  useLayoutEffect(() => {
    if (!scrollRequest || scrolledJump.current === scrollRequest.nonce) return;
    const element = scrollRef.current;
    const row = element?.querySelector(
      `[data-message-id="${CSS.escape(scrollRequest.messageId)}"]`,
    );
    if (!element || !row) return;
    scrolledJump.current = scrollRequest.nonce;
    following.current = false;
    autoScrolling.current = false;
    jumpScrolling.current = true;
    element.addEventListener("scrollend", endJumpScroll, { once: true });
    window.clearTimeout(jumpScrollTimer.current);
    jumpScrollTimer.current = window.setTimeout(endJumpScroll, 2_000);
    row.scrollIntoView({ behavior: "smooth", block: "center" });
    onScrollRequestHandled();
  }, [messages, scrollRequest, scrollRef, endJumpScroll, onScrollRequestHandled]);

  useLayoutEffect(() => {
    if (following.current) snapToEnd();
  }, [messages, running, snapToEnd]);

  // Sending always brings the conversation back to the latest message and follows the
  // reply, even if the person had scrolled up.
  useLayoutEffect(() => {
    if (!followSignal) return;
    following.current = true;
    autoScrolling.current = false;
    setAtEnd(true);
    snapToEnd();
  }, [followSignal, snapToEnd]);

  useLayoutEffect(() => {
    const button = jumpButtonRef.current;
    if (atEnd && button && document.activeElement === button) {
      button.blur();
    }
  }, [atEnd]);

  const loadOlder = useCallback(() => {
    const wasFollowing = following.current;
    // Prepend must not race the messages-driven snap-to-end follow path.
    following.current = false;
    autoScrolling.current = false;
    const pending = onLoadOlder();
    if (!pending) return;
    return Promise.resolve(pending).catch((error) => {
      const element = scrollRef.current;
      if (wasFollowing && element && transcriptIsNearEnd(element)) {
        following.current = true;
        setAtEnd(true);
      }
      throw error;
    });
  }, [onLoadOlder, scrollRef]);

  useEffect(
    () => () => {
      window.clearTimeout(autoScrollTimer.current);
      window.clearTimeout(jumpScrollTimer.current);
    },
    [],
  );

  return (
    <div className="relative flex min-h-0 flex-1">
      <div
        ref={scrollRef}
        data-testid="transcript"
        onPointerDown={(event) => {
          lastScrollTop.current = event.currentTarget.scrollTop;
          autoScrolling.current = false;
          following.current = false;
        }}
        onTouchStart={(event) => {
          lastScrollTop.current = event.currentTarget.scrollTop;
          autoScrolling.current = false;
          following.current = false;
        }}
        onWheel={(event) => {
          if (event.deltaY < 0) {
            lastScrollTop.current = event.currentTarget.scrollTop;
            autoScrolling.current = false;
            following.current = false;
          }
        }}
        onScroll={(event) => {
          const scrolledDown = transcriptMovedDown(
            lastScrollTop.current,
            event.currentTarget.scrollTop,
          );
          lastScrollTop.current = event.currentTarget.scrollTop;
          // Muse fades the transcript under the top edge once it has scrolled (styles.css).
          event.currentTarget.dataset.scrolled = String(event.currentTarget.scrollTop > 4);
          const nearEnd = transcriptIsNearEnd(event.currentTarget);
          setAtEnd(nearEnd);
          // A jump scroll owns the viewport until its animation settles; its
          // own near-end crossings must not re-arm tail-following.
          if (jumpScrolling.current) return;
          if (nearEnd) {
            if (scrolledDown) following.current = true;
            if (autoScrolling.current) {
              autoScrolling.current = false;
              window.clearTimeout(autoScrollTimer.current);
            }
          } else if (!autoScrolling.current) {
            following.current = false;
          }
        }}
        data-fade-top=""
        className={cn(
          "rk-scroll flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 py-5 md:px-7 md:py-6",
          museMode &&
            "mx-auto w-full max-w-[748px] gap-[22px] overflow-x-hidden pt-8 [overflow-wrap:anywhere] md:px-6 md:pt-9 md:pb-6",
        )}
      >
        {leading}
        {onShowEarlier ? (
          <button
            type="button"
            disabled={loadingOlder}
            onClick={() => void onShowEarlier()}
            className="self-center rounded-lg px-3 py-1.5 text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground/75 disabled:opacity-50"
          >
            {loadingOlder ? t`Loading…` : t`Show earlier messages`}
          </button>
        ) : null}
        {olderCursor != null ? (
          <button
            type="button"
            disabled={loadingOlder}
            onClick={() => void loadOlder()}
            className="self-center rounded-lg px-3 py-1.5 text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground/75 disabled:opacity-50"
          >
            {loadingOlder ? t`Loading…` : t`Load earlier messages`}
          </button>
        ) : null}
        {transcriptRows.map((row) => {
          if (row.kind === "failures") {
            const last = row.messages.at(-1) as ThreadMessage;
            return (
              <div key={row.messages[0]?.id} data-message-id={last.id}>
                <FailureRun messages={row.messages} />
              </div>
            );
          }
          const { message } = row;
          if (!museMode && !message.blocks.some((block) => !isToolActivityBlock(block)))
            return null;
          const peerReceipt = isPeerReceiptBlocks(message.blocks);
          const messageReactions = reactionView.reactions.get(message.id);
          return (
            <div
              key={message.id}
              data-message-id={message.id}
              className={peerReceipt ? "relative py-0.5" : "group/message relative hover:z-20"}
            >
              <div
                className={
                  peerReceipt
                    ? undefined
                    : `relative flex ${message.role === "user" ? "justify-end" : "justify-start"}`
                }
              >
                <div
                  data-testid={peerReceipt ? undefined : "message-bubble-frame"}
                  className={
                    peerReceipt
                      ? undefined
                      : `relative w-fit min-w-0 ${
                          message.role === "user"
                            ? museMode
                              ? "max-w-[80%]"
                              : "max-w-[min(84%,calc(100%_-_6rem))]"
                            : museMode
                              ? "max-w-full"
                              : "max-w-[min(88%,calc(100%_-_6rem))]"
                        }`
                  }
                >
                  {peerReceipt ? null : (
                    <MessageHoverActions
                      message={message}
                      side={message.role === "user" ? "start" : "end"}
                      time={
                        message.role === "user" && !message.id.startsWith("progress:") ? (
                          <time
                            dateTime={message.createdAt}
                            data-testid="message-hover-time"
                            className="me-1 hidden text-xs tabular-nums whitespace-nowrap text-muted-foreground [@media(hover:hover)_and_(pointer:fine)]:block"
                          >
                            {new Date(message.createdAt).toLocaleTimeString(i18n.locale || "en", {
                              hour: "numeric",
                              minute: "2-digit",
                            })}
                          </time>
                        ) : undefined
                      }
                      onReply={onReply}
                      onReact={onReact}
                      conversational={!museMode}
                      onFork={
                        onFork && message.forks !== undefined && forkAnchorFor(message, messages)
                          ? (clicked) => {
                              const anchor = forkAnchorFor(clicked, messages);
                              if (anchor) onFork(anchor);
                            }
                          : undefined
                      }
                      above={Boolean(onFork)}
                    />
                  )}
                  <MessageView
                    museMode={museMode}
                    botDisplayName={botDisplayName}
                    artifactTarget={artifactTarget}
                    message={message}
                    canAnswer={
                      message.id === answerableAskMessageId ||
                      Boolean(museMode && hasOpenMuseAsk(message))
                    }
                    onOpenBot={onOpenBot}
                    onOpenPeerMessages={onOpenPeerMessages}
                    onAnswer={onAnswer}
                    speakerName={
                      peerReceipt
                        ? undefined
                        : message.role === "bot"
                          ? memberName?.(message.botId)
                          : undefined
                    }
                    memberName={memberName}
                    peerBot={peerBot}
                    replyPreview={
                      message.replyToMessageId
                        ? messageById.get(message.replyToMessageId)
                        : undefined
                    }
                    replyToMessageId={message.replyToMessageId}
                    onJumpToMessage={onJumpToMessage}
                    onRefresh={onRefresh}
                    onBotChanged={onBotChanged}
                    onAddRoutine={onAddRoutine}
                    voiceReady={voiceReady}
                    speaking={speakingMessageId === message.id}
                    onSpeak={() => onSpeak(message)}
                    onOpenComputer={onOpenComputer}
                  />
                </div>
              </div>
              {peerReceipt ? null : renderUnder?.(message)}
              {!peerReceipt && messageReactions ? (
                <div
                  data-testid="message-reactions"
                  className={cn(
                    "mt-1 flex flex-wrap gap-1",
                    message.role === "user" && "justify-end",
                  )}
                >
                  {[...messageReactions].map(([emoji, count]) => (
                    <span
                      key={emoji}
                      className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs"
                    >
                      {emoji}
                      {count > 1 ? ` ${count}` : ""}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
        {running &&
        !messages.some(
          (message) =>
            message.id.startsWith("progress:") &&
            message.blocks.some(
              (block) =>
                block.kind === "progress" && !isToolActivityBlock(block) && Boolean(block.text),
            ),
        ) ? (
          museMode && museFace ? (
            museLiveLabel ? (
              <WorkingRow label={museLiveLabel} />
            ) : null
          ) : (
            <ActiveBotGlyph bots={workingBots} label={workingLabel} />
          )
        ) : null}
        {trailing}
      </div>
      {aside}
      {quoteDraft && onQuote ? (
        <QuoteSelectionButton
          range={quoteDraft.range}
          onQuote={() => {
            onQuote(quoteDraft.message, quoteDraft.text);
            window.getSelection()?.removeAllRanges();
            setQuoteDraft(null);
          }}
        />
      ) : null}
      <button
        ref={jumpButtonRef}
        type="button"
        aria-label={t`Jump to latest`}
        aria-hidden={atEnd}
        tabIndex={atEnd ? -1 : 0}
        onClick={jumpToLatest}
        className={`absolute bottom-4 left-1/2 z-20 grid h-9 w-9 -translate-x-1/2 place-items-center rounded-full border border-border bg-muted/95 text-foreground/75 shadow-md backdrop-blur transition-[opacity,transform,background-color] duration-200 ease-[cubic-bezier(.22,1,.36,1)] hover:bg-border motion-reduce:transition-none ${
          atEnd ? "pointer-events-none translate-y-2 opacity-0" : "translate-y-0 opacity-100"
        }`}
      >
        <ArrowDown size={17} strokeWidth={1.8} />
      </button>
    </div>
  );
});
