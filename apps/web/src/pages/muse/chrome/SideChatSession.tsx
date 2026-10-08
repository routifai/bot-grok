import { ChatMarkdown } from "@aiden/chat-ui/web";
import type {
  ChatSummary,
  FamilyEvent,
  SideChatStart,
  ThreadMessage,
  ThreadMessagePage,
} from "@aiden/contracts";
import {
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Switch,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@aiden/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { ChevronRight, X } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { LoadingState } from "../../../components/ai/primitives";
import { ReplyCardSendProvider } from "../../../components/cards/context";
import { type ChatProject, ProjectChip, useChatProject } from "./ProjectChip";
import { RestoreButton } from "./RestoreButton";

/** The Side Chat session's wire: what it needs from `chats.*`, kept as an explicit shape
 * (not the `rpc` client) so the dev fixture page can supply fakes instead. */
export type SideChatWire = {
  summaryPreview: (input: { botId: string }) => Promise<{ summary: string }>;
  createSide: (input: {
    botId: string;
    start: SideChatStart;
    text: string;
  }) => Promise<ChatSummary>;
  transcript: (input: { botId: string; chatId: string }) => Promise<ThreadMessagePage>;
  /** Listens to the Muse's family stream (ids only); returns the unsubscribe. Fixtures may leave
   * it out: the chat then only reads when it is opened and after a send. */
  watch?: (botId: string, listener: (event: FamilyEvent) => void) => () => void;
  send: (input: { chatId: string; text: string }) => Promise<{ ok: true }>;
  /** The person has the chat open: clears its unread flag. Fixtures may leave it out. */
  markRead?: (input: { botId: string; chatId: string }) => Promise<unknown>;
  /** The Project the chat has open; fixtures may leave it out. */
  project?: (input: { botId: string; chatId: string }) => Promise<{ project: ChatProject | null }>;
  /** Restores an archived chat; without it an archived chat shows no Restore. */
  unarchive?: (input: { botId: string; chatId: string }) => Promise<unknown>;
};

/** The context summary a person can read: markdown, capped in height, scrolls past it. */
function SummaryBody({ text }: { text: string }) {
  return (
    <div className="max-h-[320px] overflow-y-auto px-4 py-3 text-[13px] leading-[1.55]">
      <ChatMarkdown>{text}</ChatMarkdown>
    </div>
  );
}

/** The Muse a Side Chat belongs to: its face shows beside the replies. */
export type SideChatBot = { id: string; name: string; color: string };

/** The Conversation's own transcript and composer, supplied by Shell.tsx (they are defined
 * there, tied to its message rendering) so a Side Chat looks and behaves the same. */
export type SideChatView = {
  Transcript: ComponentType<{
    bot: SideChatBot;
    messages: ThreadMessage[];
    /** A reply is being written: shows the same working row as the Conversation. */
    running: boolean;
    /** Bumped on send: follow the tail again. */
    followSignal: number;
    /** Rendered at the top of the scrolling column. */
    leading?: ReactNode;
    /** Rendered at the bottom of the scrolling column, e.g. a send-failure note. */
    trailing?: ReactNode;
    /** Scroll to this message once it is rendered (a search hit). */
    scrollRequest?: { messageId: string; nonce: number } | null;
  }>;
  /** Approvals waiting in this chat (the real app supplies it; fixtures leave it out). */
  Approvals?: ComponentType<{ botId: string; chatId: string }>;
  Composer: ComponentType<{
    placeholder: string;
    sending: boolean;
    onSend: (text: string) => Promise<void>;
  }>;
};

/** A Side Chat shown as a full-size session (agreed behavior #2): either an unsent
 * draft or an existing chat, replacing the Conversation entirely while open. */
export function SideChatSession({
  bot,
  chat,
  view,
  wire,
  onCreated,
  onReplied,
  onClose,
  onOpenProject,
  onRestored,
  focusMessageId,
}: {
  bot: SideChatBot;
  /** "draft": not created yet. Otherwise the chat being viewed (possibly archived). */
  chat: ChatSummary | "draft";
  view: SideChatView;
  wire: SideChatWire;
  /** The draft just sent its first message and became a real chat. */
  onCreated: (chat: ChatSummary) => void;
  /** A reply finished: the chat is no longer live, so the Chat List should refresh. */
  onReplied?: () => void;
  onClose: () => void;
  /** Show a Project's folder (the "Working in" chip). */
  onOpenProject?: (project: ChatProject) => void;
  /** The archived chat was restored: the caller shows it as an open chat (not archived). */
  onRestored?: () => void;
  /** A search hit: scroll to this message once the chat has loaded. */
  focusMessageId?: string;
}) {
  // The draft's first message, handed to the chat it becomes so it never blinks out. `failed`:
  // the chat exists but the engine could not deliver it.
  const [first, setFirst] = useState<{ chatId: string; text: string; failed: boolean } | null>(
    null,
  );
  if (chat === "draft") {
    return (
      <DraftSideChat
        bot={bot}
        view={view}
        wire={wire}
        onCreated={(created, text) => {
          setFirst({ chatId: created.id, text, failed: Boolean(created.firstMessageErrorCode) });
          onCreated(created);
        }}
        onClose={onClose}
      />
    );
  }
  return (
    <ExistingSideChat
      key={chat.id}
      bot={bot}
      chat={chat}
      view={view}
      wire={wire}
      firstText={first?.chatId === chat.id ? first.text : undefined}
      firstFailed={first?.chatId === chat.id && first.failed}
      focusMessageId={focusMessageId}
      onReplied={onReplied}
      onClose={onClose}
      onOpenProject={onOpenProject}
      onRestored={onRestored}
    />
  );
}

/** What the person just sent, shown before the engine has recorded it. */
function optimisticMessage(chatId: string, text: string): ThreadMessage {
  return {
    id: "optimistic",
    threadId: chatId,
    seq: Number.MAX_SAFE_INTEGER,
    role: "user",
    blocks: [{ kind: "text", text }],
    createdAt: new Date().toISOString(),
  };
}

/** A calm inline note under the message that did not go through. */
export type SendFailure = { text: string; stage: "retrying" | "failed" };

const SEND_RETRY_DELAY_MS = 2500;

export function SendFailureNote({
  failure,
  onRetry,
}: {
  failure: SendFailure;
  onRetry: () => void;
}) {
  return (
    <div
      role="status"
      data-testid="side-chat-send-note"
      className="flex items-center justify-end gap-2 px-1 text-[13px] text-muted-foreground"
    >
      {failure.stage === "retrying" ? (
        <Trans>Couldn’t reach Nova’s computer. Retrying…</Trans>
      ) : (
        <>
          <Trans>Didn’t send. Try again</Trans>
          <Button type="button" size="sm" variant="outline" onClick={onRetry}>
            <Trans>Retry</Trans>
          </Button>
        </>
      )}
    </div>
  );
}

/** Floats over the transcript like the Conversation's own header: no bar, no border. */
function SessionHeader({
  title,
  meta,
  onClose,
}: {
  title: string;
  meta?: ReactNode;
  onClose: () => void;
}) {
  const { t } = useLingui();
  return (
    <div className="app-drag pointer-events-none relative z-10 flex min-h-14 shrink-0 items-center gap-3 border-b border-line px-4 py-2 md:px-6">
      <div className="pointer-events-auto min-w-0 flex-1">
        <div className="truncate text-[15px] font-semibold text-foreground" dir="auto">
          {title}
        </div>
        {meta}
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label={t`Back to the conversation`}
        className="app-no-drag pointer-events-auto grid size-9 shrink-0 place-items-center rounded-full text-ink-2 transition-colors hover:bg-selection hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        <X size={17} strokeWidth={1.75} />
      </button>
    </div>
  );
}

/** A plain-text message bubble, matching the Conversation's own bubble tokens
 * (Shell.tsx's `message-user-bubble` / `message-bot-bubble`) since that rendering is
 * defined inline in Shell.tsx and too tied to attachments/reactions/voice to import.
 * Exported for the Activity panel's read-only Helper view (ActivityRunDialog.tsx), which
 * needs the exact same rendering for a Helper's messages. */
export function MessageRow({ message }: { message: ThreadMessage }) {
  const text = message.blocks
    .filter((block): block is { kind: "text"; text: string } => block.kind === "text")
    .map((block) => block.text)
    .join("\n\n");
  if (!text) return null;
  if (message.role === "system") {
    return (
      <p className="self-center text-[12.5px] text-muted-foreground" dir="auto">
        {text}
      </p>
    );
  }
  if (message.role === "user") {
    return (
      <div className="flex w-fit max-w-full justify-end">
        <div
          className="max-w-full rounded-[20px] rounded-ee-[6px] bg-bubble px-4 py-2.5 text-[15.5px] leading-[1.6] whitespace-pre-wrap wrap-anywhere text-chat-user-foreground"
          dir="auto"
        >
          {text}
        </div>
      </div>
    );
  }
  return (
    <div className="flex w-fit max-w-full justify-start">
      <div className="max-w-full text-[15.5px] leading-[1.6] text-foreground" dir="auto">
        <ChatMarkdown>{text}</ChatMarkdown>
      </div>
    </div>
  );
}

function DraftSideChat({
  bot,
  view,
  wire,
  onCreated,
  onClose,
}: {
  bot: SideChatBot;
  view: SideChatView;
  wire: SideChatWire;
  onCreated: (chat: ChatSummary, text: string) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [sent, setSent] = useState<string | null>(null);
  const [knows, setKnows] = useState(true);
  const [preview, setPreview] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<SendFailure | null>(null);

  useEffect(() => {
    let cancelled = false;
    void wire
      .summaryPreview({ botId: bot.id })
      .then(({ summary }) => {
        if (!cancelled) setPreview(summary);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [bot.id, wire]);

  const send = (text: string) => {
    setSending(true);
    setSent(text);
    setFailure(null);
    return wire
      .createSide({ botId: bot.id, start: knows ? "withContext" : "blank", text })
      .then((created) => onCreated(created, text))
      .catch(() => {
        setSending(false);
        setFailure({ text, stage: "failed" });
      });
  };

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col">
      <SessionHeader title={t`New side chat`} onClose={onClose} />
      {sent === null ? (
        <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
          <h2 className="text-[19px] font-semibold tracking-[-0.01em] text-foreground">
            <Trans>What do you want to look at?</Trans>
          </h2>
        </div>
      ) : (
        <view.Transcript
          bot={bot}
          messages={[optimisticMessage("draft", sent)]}
          running={failure === null}
          followSignal={1}
          trailing={
            failure ? (
              <SendFailureNote failure={failure} onRetry={() => void send(failure.text)} />
            ) : null
          }
        />
      )}
      <div
        className={`mx-auto mb-1 w-full max-w-[748px] justify-center px-4 ${sent === null ? "flex" : "hidden"}`}
      >
        <Tooltip>
          <TooltipTrigger
            type="button"
            role="switch"
            aria-checked={knows}
            onClick={() => setKnows((value) => !value)}
            className="inline-flex h-8 items-center gap-2.5 rounded-full border border-border bg-card px-1 pe-3 text-[13.5px] text-foreground"
          >
            {/* Display only: the pill owns the click, or one click would toggle twice. */}
            <Switch
              checked={knows}
              size="sm"
              tabIndex={-1}
              aria-hidden="true"
              className="pointer-events-none"
            />
            <Trans>Knows our conversation</Trans>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-[320px] text-[12.5px] leading-[1.5]">
            {knows ? (
              <Trans>It starts with a summary of this conversation.</Trans>
            ) : (
              <Trans>It starts fresh, with only what Nova knows about you.</Trans>
            )}
          </TooltipContent>
        </Tooltip>
        {knows && preview ? (
          <Popover>
            <PopoverTrigger
              type="button"
              className="ms-2 inline-flex h-8 items-center rounded-full px-3 text-[13px] text-muted-foreground hover:text-foreground"
            >
              <Trans>See summary</Trans>
            </PopoverTrigger>
            <PopoverContent side="top" className="w-[min(420px,calc(100vw-2rem))] p-0">
              <SummaryBody text={preview} />
            </PopoverContent>
          </Popover>
        ) : null}
      </div>
      <view.Composer placeholder={t`Message this side chat`} sending={sending} onSend={send} />
    </div>
  );
}

/** How long a reply may take before the send is reported as failed. */
const REPLY_WAIT_MAX_MS = 3 * 60 * 1000;
/** A reply's message can land just before the chat stops being live: look once more. */
const SETTLE_RECHECK_MS = 1500;

const userCount = (messages: ThreadMessage[] | null) =>
  messages?.filter((message) => message.role === "user").length ?? 0;

/** The chat a session reads: enough of a `ChatSummary` (a fork's stub carries no more). */
export type SideChatRef = Pick<ChatSummary, "id" | "live" | "unread" | "archived">;

/**
 * One Side Chat's messages and sending, shared by its full-size session and a Fork's thread
 * view: reads the transcript when opened, after a send and when the family stream says a reply
 * landed; shows the person's message at once; marks the chat read while it is in view; retries
 * a failed send once, then reports it.
 */
export function useSideChatThread({
  bot,
  chat,
  wire,
  firstText,
  firstFailed = false,
  onReplied,
}: {
  bot: { id: string };
  chat: SideChatRef;
  wire: SideChatWire;
  firstText?: string;
  /** The chat was created but its first message did not send: shown as not sent, to resend. */
  firstFailed?: boolean;
  onReplied?: () => void;
}) {
  const [messages, setMessages] = useState<ThreadMessage[] | null>(null);
  const [lineage, setLineage] = useState<ThreadMessagePage["lineage"] | null>(null);
  /** Sent but not yet in the fetched messages; shown at once, dropped when it arrives. */
  const [pending, setPending] = useState<{ text: string; base: number } | null>(
    firstText ? { text: firstText, base: 0 } : null,
  );
  /** A reply is expected: from send until the engine has answered and gone idle. */
  const [waiting, setWaiting] = useState(Boolean(firstText) && !firstFailed);
  const [engineRunning, setEngineRunning] = useState(chat.live);
  /** A Helper's chat: read, never written to. */
  const [readOnly, setReadOnly] = useState(false);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<SendFailure | null>(
    firstFailed && firstText ? { text: firstText, stage: "failed" } : null,
  );
  const [followSignal, setFollowSignal] = useState(0);
  const generation = useRef(0);
  /** A turn is in flight (from the list's live dot or our own send) until we see it end. */
  const busy = useRef((Boolean(firstText) && !firstFailed) || chat.live);
  const pendingRef = useRef<{ text: string; base: number } | null>(
    firstText ? { text: firstText, base: 0 } : null,
  );
  const repliedRef = useRef(onReplied);
  repliedRef.current = onReplied;

  const refresh = () => {
    const current = generation.current;
    return wire
      .transcript({ botId: bot.id, chatId: chat.id })
      .then((page) => {
        if (current !== generation.current) return;
        const running = page.running ?? false;
        setMessages(page.messages);
        setLineage(page.lineage ?? null);
        setReadOnly(page.readOnly ?? false);
        if (pendingRef.current && userCount(page.messages) > pendingRef.current.base) {
          pendingRef.current = null;
        }
        setEngineRunning(running);
        setPending((now) => (now && userCount(page.messages) > now.base ? null : now));
        if (running) busy.current = true;
        // A message not recorded yet (a new chat's first one goes out once its context is
        // ready) is still being answered, even before the engine says it is running.
        if (!running && !pendingRef.current && page.messages.at(-1)?.role !== "user") {
          setWaiting(false);
          // The sidebar's live dot comes from the list: tell it this chat went quiet.
          if (busy.current) {
            busy.current = false;
            repliedRef.current?.();
          }
        }
      })
      .catch(() => {
        if (current === generation.current) setMessages((now) => now ?? []);
      });
  };

  useEffect(() => {
    generation.current += 1;
    void refresh();
    return () => {
      generation.current += 1;
    };
  }, [chat.id, wire]);

  // Viewing the chat reads it: on opening an unread one, when a reply lands while it is in
  // view, and when the person comes back to the window. The engine announces the change.
  const unreadRef = useRef(chat.unread ?? false);
  unreadRef.current = chat.unread ?? false;
  const markSeen = () => {
    if (!wire.markRead || document.visibilityState !== "visible" || !document.hasFocus()) return;
    void wire.markRead({ botId: bot.id, chatId: chat.id }).catch(() => undefined);
  };
  const markSeenRef = useRef(markSeen);
  markSeenRef.current = markSeen;
  useEffect(() => {
    if (unreadRef.current) markSeenRef.current();
    const onBack = () => {
      if (unreadRef.current) markSeenRef.current();
    };
    window.addEventListener("focus", onBack);
    document.addEventListener("visibilitychange", onBack);
    return () => {
      window.removeEventListener("focus", onBack);
      document.removeEventListener("visibilitychange", onBack);
    };
  }, [chat.id]);

  const awaitingReply = !chat.archived && (waiting || engineRunning);
  const awaitingRef = useRef(awaitingReply);
  awaitingRef.current = awaitingReply;
  // The chat reads again when the engine says a reply landed (and after a reconnect); a quiet
  // heartbeat settles a chat whose last reply raced its live flag. A change to the family's
  // chats (a fork of this chat opened or added back) reads it too.
  useEffect(() => {
    if (!wire.watch) return;
    let recheck: number | undefined;
    const stop = wire.watch(bot.id, (event) => {
      if ((event.type === "messageDone" || event.type === "turnDone") && event.chatId === chat.id) {
        if (event.type === "messageDone") markSeenRef.current();
        void refresh();
        window.clearTimeout(recheck);
        recheck = window.setTimeout(() => void refresh(), SETTLE_RECHECK_MS);
      } else if (
        event.type === "open" ||
        event.type === "chatsChanged" ||
        (event.type === "heartbeat" && awaitingRef.current)
      ) {
        void refresh();
      }
    });
    return () => {
      window.clearTimeout(recheck);
      stop();
    };
  }, [bot.id, chat.id, wire]);

  useEffect(() => {
    if (!awaitingReply) return;
    const timer = window.setTimeout(() => {
      setWaiting(false);
      setFailure(
        (now) =>
          now ?? (pendingRef.current ? { text: pendingRef.current.text, stage: "failed" } : null),
      );
    }, REPLY_WAIT_MAX_MS);
    return () => window.clearTimeout(timer);
  }, [awaitingReply, chat.id]);

  const send = (text: string) => {
    setPending({ text, base: userCount(messages) });
    pendingRef.current = { text, base: userCount(messages) };
    busy.current = true;
    setWaiting(true);
    setSending(true);
    setFailure(null);
    setFollowSignal((value) => value + 1);
    const post = () => wire.send({ chatId: chat.id, text });
    // One quiet retry covers the Computer waking up; a second failure is shown, never silent.
    return post()
      .catch(() => {
        setFailure({ text, stage: "retrying" });
        return new Promise<void>((resolve) => window.setTimeout(resolve, SEND_RETRY_DELAY_MS)).then(
          post,
        );
      })
      .then(() => {
        setFailure(null);
        return refresh();
      })
      .catch(() => {
        setFailure({ text, stage: "failed" });
        setWaiting(false);
        busy.current = false;
      })
      .finally(() => setSending(false));
  };

  const shown =
    pending === null
      ? (messages ?? [])
      : [...(messages ?? []), optimisticMessage(chat.id, pending.text)];

  return {
    /** `null` until the first read. */
    messages,
    /** The messages plus the person's message not yet recorded. */
    shown,
    /** Nothing to show yet: not read, and nothing sent. */
    loading: messages === null && pending === null,
    lineage,
    readOnly,
    sending,
    failure,
    awaitingReply,
    followSignal,
    send,
    refresh,
  };
}

function ExistingSideChat({
  bot,
  chat,
  view,
  wire,
  firstText,
  firstFailed = false,
  focusMessageId,
  onReplied,
  onClose,
  onOpenProject,
  onRestored,
}: {
  bot: SideChatBot;
  chat: ChatSummary;
  view: SideChatView;
  wire: SideChatWire;
  firstText?: string;
  /** The chat was created but its first message did not send: shown as not sent, to resend. */
  firstFailed?: boolean;
  focusMessageId?: string;
  onReplied?: () => void;
  onClose: () => void;
  onOpenProject?: (project: ChatProject) => void;
  onRestored?: () => void;
}) {
  const { t } = useLingui();
  const {
    messages,
    shown,
    loading,
    readOnly,
    sending,
    failure,
    awaitingReply,
    followSignal,
    send,
  } = useSideChatThread({ bot, chat, wire, firstText, firstFailed, onReplied });
  const loadProject = wire.project;
  const unarchive = wire.unarchive;
  const project = useChatProject(
    loadProject ? () => loadProject({ botId: bot.id, chatId: chat.id }) : undefined,
    chat.id,
    `${messages?.length ?? 0}:${awaitingReply}`,
  );

  const scrollRequest = useMemo(
    () => (focusMessageId ? { messageId: focusMessageId, nonce: 1 } : null),
    [focusMessageId],
  );

  const context =
    chat.start === "withContext" && chat.summary ? (
      <details className="group w-fit max-w-full text-[13px] text-muted-foreground">
        <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-full bg-muted/60 px-3 py-1 [&::-webkit-details-marker]:hidden">
          <Trans>With context</Trans>
          <ChevronRight size={12} className="shrink-0 transition-transform group-open:rotate-90" />
        </summary>
        <div className="mt-2 rounded-2xl bg-muted/60 text-foreground/80">
          <SummaryBody text={chat.summary} />
        </div>
      </details>
    ) : null;

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col">
      <SessionHeader
        title={chat.title}
        meta={
          chat.archived || (project && onOpenProject) ? (
            <div className="mt-1 flex items-center gap-2">
              {chat.archived ? (
                <span className="text-[12px] text-muted-foreground">
                  <Trans>Archived</Trans>
                </span>
              ) : null}
              {chat.archived && unarchive ? (
                <RestoreButton
                  onRestore={() =>
                    unarchive({ botId: bot.id, chatId: chat.id }).then(() => onRestored?.())
                  }
                />
              ) : null}
              {project && onOpenProject ? (
                <ProjectChip project={project} onOpen={onOpenProject} />
              ) : null}
            </div>
          ) : undefined
        }
        onClose={onClose}
      />
      {loading ? (
        <div data-testid="side-chat-loading" className="flex flex-1 items-center justify-center">
          <LoadingState label={t`Loading…`} />
        </div>
      ) : (
        <ReplyCardSendProvider send={(text) => void send(text)}>
          <view.Transcript
            bot={bot}
            messages={shown}
            running={sending || awaitingReply}
            followSignal={followSignal}
            leading={context}
            scrollRequest={scrollRequest}
            trailing={
              <>
                {view.Approvals ? <view.Approvals botId={bot.id} chatId={chat.id} /> : null}
                {failure ? (
                  <SendFailureNote failure={failure} onRetry={() => void send(failure.text)} />
                ) : null}
              </>
            }
          />
        </ReplyCardSendProvider>
      )}
      {chat.archived || readOnly ? null : (
        <view.Composer placeholder={t`Message this side chat`} sending={sending} onSend={send} />
      )}
    </div>
  );
}
