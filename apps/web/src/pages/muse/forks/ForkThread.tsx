import { Trans, useLingui } from "@lingui/react/macro";
import type { MessageFork, ThreadMessage } from "@nova/contracts";
import { userVisibleMessages } from "@nova/core";
import { Button, cn, Spinner } from "@nova/ui-web";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ReplyCardBotProvider,
  ReplyCardSendProvider,
  ReplyCardThreadProvider,
} from "../../../components/cards/context";
import type { ArtifactTarget } from "../../../lib/artifact-open";
import { RestoreButton } from "../chrome/RestoreButton";
import {
  SendFailureNote,
  type SideChatBot,
  type SideChatRef,
  useSideChatThread,
} from "../chrome/SideChatSession";
import { MessageHoverActions } from "../conversation/MessageHoverActions";
import { MessageView } from "../conversation/MessageView";
import { ForkComposer } from "./ForkComposer";
import { ForkOverlay, type ForkWire, LiftedMessage, OverlayTopBar } from "./ForkOverlay";
import { ForkUnderMessage } from "./ForkUnderMessage";
import {
  FORK_TONE_CLASS,
  type ForkStatus,
  type ForkTone,
  forkTone,
  messageForkStatus,
} from "./forkModel";
import { LiveDot } from "./forkParts";

/** The fork a thread view shows, and what its opener already knows of it. */
export type ForkThreadTarget = {
  chat: SideChatRef & { title: string };
  /** The message it started from, when the opener has it (else it is looked up). */
  anchor: ThreadMessage | null;
  /** A fork just opened: its first message, shown before the engine records it. */
  firstText?: string;
  firstFailed?: boolean;
};

/** A fork's entry on its anchor as a thread target. */
export function forkTarget(fork: MessageFork, anchor: ThreadMessage | null): ForkThreadTarget {
  return {
    chat: {
      id: fork.chatId,
      title: fork.title,
      live: fork.live,
      unread: fork.unread,
      archived: fork.state === "archived",
    },
    anchor,
  };
}

const noop = () => undefined;
const noopAsync = async () => undefined;
const NOT_LIVE_BOT = () => undefined;
/** Within this distance of the end, new replies keep the view following. */
const FOLLOW_SLACK_PX = 120;

/**
 * One fork over the blurred Conversation (ADR 0010): its anchor lifted at the top, sibling forks
 * of the same message as pills, the replies hanging off one line in the fork's color, and a
 * composer in that color with "Add to Conversation", "Open as side chat" and "Archive". Its
 * messages and sending are the Side Chat's own (`useSideChatThread`).
 */
export function ForkThread({
  bot,
  wire,
  target,
  conversationId,
  conversationMessages,
  onClose,
  onOpenFork,
  onAsk,
  onOpenSideChat,
  onAdded,
  onArchived,
  onRestored,
  onReplied,
  onMissingAnchor,
}: {
  bot: SideChatBot;
  wire: ForkWire;
  target: ForkThreadTarget;
  /** The Conversation's engine id: a fork's parent when it is a first-level fork. */
  conversationId: string | null;
  conversationMessages: readonly ThreadMessage[];
  onClose: () => void;
  onOpenFork: (target: ForkThreadTarget) => void;
  /** Fork one of this fork's own messages (a fork of a fork). */
  onAsk: (anchor: ThreadMessage, chatId: string) => void;
  onOpenSideChat: (chat: ForkThreadTarget["chat"]) => void;
  /** Its summary went back under the anchor (the anchor's id, when known). */
  onAdded: (anchorItemId: string | null) => void;
  onArchived: () => void;
  /** An archived fork was restored: shown as an open fork again, writable. */
  onRestored?: () => void;
  onReplied?: () => void;
  /** The anchor is a Conversation message that is not loaded yet: page back to it. */
  onMissingAnchor?: (anchorItemId: string) => void;
}) {
  const { t } = useLingui();
  const { chat } = target;
  const thread = useSideChatThread({
    bot,
    chat,
    wire,
    firstText: target.firstText,
    firstFailed: target.firstFailed,
    onReplied,
  });
  const lineage = thread.lineage;
  const anchorId = lineage?.anchorItemId ?? target.anchor?.id ?? null;
  const parentId = lineage?.parentId ?? null;
  const parentIsConversation = Boolean(
    parentId && parentId === (lineage?.rootId ?? conversationId),
  );

  // The anchor, fresh: from the Conversation as it updates, or (a fork of a fork) from the fork
  // it came from.
  const [parentAnchor, setParentAnchor] = useState<ThreadMessage | null>(null);
  useEffect(() => {
    setParentAnchor(null);
    if (!anchorId || !parentId || parentIsConversation) return;
    let cancelled = false;
    void wire
      .transcript({ botId: bot.id, chatId: parentId })
      .then((page) => {
        if (!cancelled) setParentAnchor(page.messages.find((m) => m.id === anchorId) ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [anchorId, bot.id, parentId, parentIsConversation, wire, thread.messages?.length]);
  const inConversation = conversationMessages.find((message) => message.id === anchorId);
  const anchor = inConversation ?? parentAnchor ?? target.anchor;
  const missingRef = useRef(onMissingAnchor);
  missingRef.current = onMissingAnchor;
  const missing = Boolean(anchorId && parentIsConversation && !inConversation);
  useEffect(() => {
    if (missing && anchorId) missingRef.current?.(anchorId);
  }, [missing, anchorId]);

  const entry = anchor?.forks?.find((fork) => fork.chatId === chat.id);
  const status: ForkStatus =
    chat.archived || entry?.state === "archived"
      ? "archived"
      : entry?.state === "added"
        ? "added"
        : thread.awaitingReply || entry?.live
          ? "live"
          : "open";
  const tone = forkTone({ chatId: chat.id, status });
  const toneClass = FORK_TONE_CLASS[tone];
  // The message's other forks as pills (never archived ones; this one even when it is).
  const pills = (anchor?.forks ?? []).filter(
    (fork) => fork.chatId === chat.id || fork.state !== "archived",
  );
  const siblings = pills.length > 1 ? pills : [];
  // A fork of the Conversation can be forked once more; deeper starts a plain Side Chat.
  const canFork = Boolean(lineage && parentIsConversation) && status !== "archived";
  const writable = status !== "archived" && !thread.readOnly;

  const messages = useMemo(
    () => userVisibleMessages(thread.shown, { includePeerReceipts: true }),
    [thread.shown],
  );
  const lastRole = messages.at(-1)?.role;
  const working = status === "live" && lastRole === "user";

  // Opens at the top, with the anchor; follows new replies while the person is near the end.
  const scrollRef = useRef<HTMLDivElement>(null);
  const following = useRef(false);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (thread.followSignal > 0) following.current = true;
    if (following.current) element.scrollTo({ top: element.scrollHeight });
  }, [thread.followSignal, messages.length, working]);
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const onScroll = () => {
      following.current =
        element.scrollHeight - element.scrollTop - element.clientHeight < FOLLOW_SLACK_PX;
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, []);

  const backRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState<"add" | "archive" | null>(null);
  const [actionFailed, setActionFailed] = useState(false);
  const act = async (kind: "add" | "archive") => {
    setBusy(kind);
    setActionFailed(false);
    try {
      if (kind === "add") {
        await wire.addToConversation({ botId: bot.id, chatId: chat.id });
        onAdded(anchorId);
      } else {
        await wire.archive({ botId: bot.id, chatId: chat.id });
        onArchived();
      }
    } catch {
      setActionFailed(true);
    } finally {
      setBusy(null);
    }
  };

  const artifactTarget = useMemo<ArtifactTarget>(() => ({ botId: bot.id }), [bot.id]);

  return (
    <ForkOverlay
      label={chat.title || t`Fork`}
      onClose={onClose}
      scrollRef={scrollRef}
      initialFocusRef={backRef}
    >
      <div
        data-testid="fork-thread"
        className="mx-auto flex min-h-full max-w-[660px] flex-col gap-3.5 px-3 pt-4 pb-5 sm:px-6 sm:pt-[22px] sm:pb-7"
      >
        <OverlayTopBar onClose={onClose} backRef={backRef}>
          {siblings.map((fork) => {
            const siblingTone = forkTone({ chatId: fork.chatId, status: messageForkStatus(fork) });
            const current = fork.chatId === chat.id;
            return (
              <button
                key={fork.chatId}
                type="button"
                aria-current={current || undefined}
                onClick={() => (current ? undefined : onOpenFork(forkTarget(fork, anchor)))}
                className={cn(
                  "inline-flex h-7 max-w-[220px] items-center gap-1.5 rounded-full border bg-card px-3 text-[12.5px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                  current
                    ? cn(FORK_TONE_CLASS[siblingTone].border, "text-foreground")
                    : "border-line text-ink-2 hover:text-foreground",
                )}
              >
                <i
                  aria-hidden="true"
                  className={cn("size-2 shrink-0 rounded-full", FORK_TONE_CLASS[siblingTone].bg)}
                />
                <span className="truncate" dir="auto">
                  {fork.title}
                </span>
              </button>
            );
          })}
          <span className="flex-1" />
          <StatePill status={status} tone={tone} />
        </OverlayTopBar>

        {anchor ? <LiftedMessage message={anchor} /> : null}

        <ReplyCardBotProvider botId={bot.id}>
          <ReplyCardThreadProvider messages={messages}>
            <ReplyCardSendProvider send={(text) => void thread.send(text)}>
              <div className="relative flex flex-col gap-3 ps-8 sm:ps-[52px]">
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute start-3.5 -top-3.5 bottom-[22px] w-0.5 rounded-full opacity-45 sm:start-[26px]",
                    toneClass.bg,
                  )}
                />
                {thread.loading ? (
                  <div className="flex items-center gap-2 py-2 text-ink-3">
                    <Spinner className="size-3.5" />
                  </div>
                ) : null}
                {messages.map((message, index) => (
                  <ThreadReply
                    key={message.id}
                    message={message}
                    index={index}
                    tone={tone}
                    artifactTarget={artifactTarget}
                    canFork={canFork && message.forks !== undefined}
                    onFork={(anchorMessage) => onAsk(anchorMessage, chat.id)}
                    onOpenFork={(fork, forkAnchor) => onOpenFork(forkTarget(fork, forkAnchor))}
                  />
                ))}
                {working ? (
                  <div
                    data-testid="fork-working"
                    className="relative flex w-fit items-center gap-1.5 rounded-[18px] rounded-es-[6px] bg-card px-3.5 py-3"
                  >
                    <Connector tone={tone} />
                    <LiveDot tone={tone} />
                  </div>
                ) : null}
                {thread.failure ? (
                  <SendFailureNote
                    failure={thread.failure}
                    onRetry={() => void thread.send(thread.failure?.text ?? "")}
                  />
                ) : null}
              </div>
            </ReplyCardSendProvider>
          </ReplyCardThreadProvider>
        </ReplyCardBotProvider>

        {/* The reply bar floats over the thread: a soft ground fades the messages out behind it. */}
        <div className="sticky bottom-0 isolate mt-auto flex flex-col gap-2.5 pt-2 pb-3 before:absolute before:-inset-x-6 before:-top-8 before:-bottom-7 before:-z-10 before:bg-linear-to-t before:from-ground before:from-60% before:to-transparent before:content-[''] sm:ps-[52px]">
          {writable ? (
            <ForkComposer
              tone={tone}
              placeholder={t`Reply in “${chat.title}”`}
              sending={thread.sending}
              onSend={(text) => {
                void thread.send(text);
                return true;
              }}
            />
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {status === "open" || status === "live" ? (
              <Button
                type="button"
                size="sm"
                disabled={busy !== null}
                aria-busy={busy === "add" || undefined}
                onClick={() => void act("add")}
              >
                {busy === "add" ? <Spinner className="size-3.5" /> : null}
                <Trans>Add to Conversation</Trans>
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="bg-card"
              onClick={() => onOpenSideChat(chat)}
            >
              <Trans>Open as side chat</Trans>
            </Button>
            {status !== "archived" ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="bg-card"
                disabled={busy !== null}
                aria-busy={busy === "archive" || undefined}
                onClick={() => void act("archive")}
              >
                {busy === "archive" ? <Spinner className="size-3.5" /> : null}
                <Trans>Archive</Trans>
              </Button>
            ) : wire.unarchive ? (
              <RestoreButton
                className="bg-card"
                onRestore={async () => {
                  await wire.unarchive?.({ botId: bot.id, chatId: chat.id });
                  onRestored?.();
                }}
              />
            ) : null}
            {actionFailed ? (
              <span role="alert" className="text-[12.5px] text-muted-foreground">
                {t`Something went wrong.`}
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </ForkOverlay>
  );
}

function StatePill({ status, tone }: { status: ForkStatus; tone: ForkTone }) {
  if (status === "open") return null;
  return (
    <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-line bg-card px-3 text-[12.5px] font-medium text-ink-2">
      {status === "live" ? (
        <>
          <span
            aria-hidden="true"
            className={cn(
              "size-2 rounded-full animate-[rkPulse_1.6s_ease-in-out_infinite] motion-reduce:animate-none",
              FORK_TONE_CLASS[tone].bg,
            )}
          />
          <Trans>Nova is working</Trans>
        </>
      ) : status === "added" ? (
        <>
          <span aria-hidden="true" className="size-2 rounded-full bg-success" />
          <Trans>Added to Conversation</Trans>
        </>
      ) : (
        <Trans>Archived</Trans>
      )}
    </span>
  );
}

/** The short line from the thread's spine to a reply of Nova's. */
function Connector({ tone }: { tone: ForkTone }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "absolute -start-[18px] top-[18px] h-0.5 w-3.5 opacity-45 sm:-start-[26px] sm:w-5",
        FORK_TONE_CLASS[tone].bg,
      )}
    />
  );
}

/** One message of the fork: the person's in a bubble of the fork's color, Nova's on a card
 * hanging off the spine, with the same rendering as the Conversation. */
function ThreadReply({
  message,
  index,
  tone,
  artifactTarget,
  canFork,
  onFork,
  onOpenFork,
}: {
  message: ThreadMessage;
  index: number;
  tone: ForkTone;
  artifactTarget: ArtifactTarget;
  canFork: boolean;
  onFork: (message: ThreadMessage) => void;
  onOpenFork: (fork: MessageFork, anchor: ThreadMessage) => void;
}) {
  const user = message.role === "user";
  const text = user
    ? message.blocks.flatMap((block) => (block.kind === "text" ? [block.text] : [])).join("\n\n")
    : "";
  return (
    <div
      data-message-id={message.id}
      style={{ animationDelay: `${Math.min(index, 8) * 60}ms` }}
      className={cn(
        "group/message relative flex flex-col animate-[forkRise_300ms_cubic-bezier(.2,.8,.2,1)_both] motion-reduce:animate-none",
        user ? "items-end" : "items-start",
      )}
    >
      <div className={cn("relative min-w-0", user ? "max-w-[82%]" : "max-w-[92%]")}>
        {message.id === "optimistic" ? null : (
          <MessageHoverActions
            message={message}
            side={user ? "start" : "end"}
            onReact={noopAsync}
            conversational={false}
            onFork={canFork ? onFork : undefined}
          />
        )}
        {user ? (
          <div
            className={cn(
              "rounded-[18px] rounded-ee-[6px] px-[15px] py-[9px] text-[14.5px] leading-[1.55] whitespace-pre-wrap wrap-anywhere text-solid",
              FORK_TONE_CLASS[tone].bg,
            )}
            dir="auto"
          >
            {text}
          </div>
        ) : (
          <div className="relative rounded-[18px] rounded-es-[6px] bg-card px-3.5 py-3 text-[14.5px]">
            <Connector tone={tone} />
            <MessageView
              museMode
              artifactTarget={artifactTarget}
              message={message}
              canAnswer={false}
              onOpenBot={noop}
              onOpenPeerMessages={noop}
              onAnswer={noopAsync}
              peerBot={NOT_LIVE_BOT}
              onRefresh={noopAsync}
              onBotChanged={noopAsync}
              onAddRoutine={noop}
              voiceReady={false}
              speaking={false}
              onSpeak={noop}
              onOpenComputer={noop}
            />
          </div>
        )}
      </div>
      <ForkUnderMessage
        message={message}
        onOpenFork={onOpenFork}
        onNewFork={canFork ? onFork : undefined}
      />
    </div>
  );
}
