import { ChatMarkdown } from "@aiden/chat-ui/web";
import type {
  ChatSummary,
  SideChatStart,
  ThreadMessage,
  ThreadMessagePage,
} from "@aiden/contracts";
import { Switch, Tooltip, TooltipContent, TooltipTrigger } from "@aiden/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { ChevronRight, X } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

/** The Side Chat session's wire: what it needs from `chats.*`, kept as an explicit shape
 * (not the `rpc` client) so the dev fixture page can supply fakes instead. */
export type SideChatWire = {
  summaryPreview: (input: { botId: string }) => Promise<{ summary: string }>;
  createSide: (input: {
    botId: string;
    start: SideChatStart;
    text: string;
  }) => Promise<ChatSummary>;
  messages: (input: { chatId: string }) => Promise<ThreadMessagePage>;
  send: (input: { chatId: string; text: string }) => Promise<{ ok: true }>;
};

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
  }>;
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
  onClose,
}: {
  bot: SideChatBot;
  /** "draft": not created yet. Otherwise the chat being viewed (possibly archived). */
  chat: ChatSummary | "draft";
  view: SideChatView;
  wire: SideChatWire;
  /** The draft just sent its first message and became a real chat. */
  onCreated: (chat: ChatSummary) => void;
  onClose: () => void;
}) {
  if (chat === "draft") {
    return (
      <DraftSideChat bot={bot} view={view} wire={wire} onCreated={onCreated} onClose={onClose} />
    );
  }
  return (
    <ExistingSideChat
      key={chat.id}
      bot={bot}
      chat={chat}
      view={view}
      wire={wire}
      onClose={onClose}
    />
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
    <div className="app-drag pointer-events-none absolute inset-x-0 top-0 z-10 flex h-16 items-center gap-3 px-4 md:px-6">
      <div className="pointer-events-auto min-w-0 flex-1">
        <div className="truncate text-[14.5px] font-medium text-foreground" dir="auto">
          {title}
        </div>
        {meta}
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label={t`Back to the conversation`}
        className="app-no-drag pointer-events-auto grid size-9 shrink-0 place-items-center rounded-full border border-border/60 bg-card/80 text-muted-foreground shadow-sm backdrop-blur-md transition-colors hover:bg-accent hover:text-foreground"
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
          className="max-w-full rounded-3xl bg-chat-user px-5 py-3 text-[16px] leading-[1.6] whitespace-pre-wrap wrap-anywhere text-chat-user-foreground"
          dir="auto"
        >
          {text}
        </div>
      </div>
    );
  }
  return (
    <div className="flex w-fit max-w-full justify-start">
      <div className="max-w-full text-[16px] leading-[1.65] text-foreground" dir="auto">
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
  onCreated: (chat: ChatSummary) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [knows, setKnows] = useState(true);
  const [preview, setPreview] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

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
    return wire
      .createSide({ botId: bot.id, start: knows ? "withContext" : "blank", text })
      .then(onCreated)
      .catch(() => setSending(false));
  };

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col">
      <SessionHeader title={t`New side chat`} onClose={onClose} />
      <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        <h2 className="text-[19px] font-semibold tracking-[-0.01em] text-foreground">
          <Trans>What do you want to look at?</Trans>
        </h2>
      </div>
      <div className="mx-auto mb-1 flex w-full max-w-[820px] justify-center px-4">
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
              preview ? (
                <Trans>It starts with this summary: “{preview}”</Trans>
              ) : (
                <Trans>It starts with a summary of this conversation.</Trans>
              )
            ) : (
              <Trans>It starts fresh, with only what Nova knows about you.</Trans>
            )}
          </TooltipContent>
        </Tooltip>
      </div>
      <view.Composer placeholder={t`Message this side chat`} sending={sending} onSend={send} />
    </div>
  );
}

const REPLY_POLL_INTERVAL_MS = 3000;
const REPLY_POLL_MAX_MS = 3 * 60 * 1000;

function ExistingSideChat({
  bot,
  chat,
  view,
  wire,
  onClose,
}: {
  bot: SideChatBot;
  chat: ChatSummary;
  view: SideChatView;
  wire: SideChatWire;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [messages, setMessages] = useState<ThreadMessage[] | null>(null);
  const [sending, setSending] = useState(false);
  const [followSignal, setFollowSignal] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    void wire
      .messages({ chatId: chat.id })
      .then((page) => {
        if (current === generation.current) setMessages(page.messages);
      })
      .catch(() => {
        if (current === generation.current) setMessages([]);
      });
    return () => {
      generation.current += 1;
    };
  }, [chat.id, wire]);

  // Follow a reply while it's being written: the turn runs in the background.
  const lastRole = messages?.at(-1)?.role;
  const awaitingReply = !chat.archived && (chat.live || lastRole === "user");
  useEffect(() => {
    if (!awaitingReply) return;
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      if (Date.now() - startedAt > REPLY_POLL_MAX_MS) {
        window.clearInterval(timer);
        return;
      }
      void wire
        .messages({ chatId: chat.id })
        .then((page) => setMessages(page.messages))
        .catch(() => undefined);
    }, REPLY_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [awaitingReply, chat.id, wire]);

  const send = (text: string) => {
    setSending(true);
    setFollowSignal((value) => value + 1);
    return wire
      .send({ chatId: chat.id, text })
      .then(() =>
        wire
          .messages({ chatId: chat.id })
          .then((page) => setMessages(page.messages))
          .catch(() => undefined),
      )
      .finally(() => setSending(false));
  };

  const context =
    chat.start === "blank" ? (
      <div className="rounded-2xl bg-muted/60 px-4 py-2.5 text-[13.5px] text-muted-foreground">
        <Trans>Started blank — knows only what Nova knows about you.</Trans>
      </div>
    ) : (
      <details className="group rounded-2xl bg-muted/60 px-4 py-2.5 text-[13.5px] text-muted-foreground">
        <summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
          <span>
            <Trans>Started with context — a summary of your conversation</Trans>
          </span>
          <ChevronRight
            size={13}
            className="ms-auto shrink-0 transition-transform group-open:rotate-90"
          />
        </summary>
        {chat.summary ? <p className="mt-2 text-foreground/80">{chat.summary}</p> : null}
      </details>
    );

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col">
      <SessionHeader
        title={chat.title}
        meta={
          chat.archived ? (
            <span className="text-[12.5px] text-muted-foreground">
              <Trans>Archived after a quiet stretch — read-only</Trans>
            </span>
          ) : undefined
        }
        onClose={onClose}
      />
      <view.Transcript
        bot={bot}
        messages={messages ?? []}
        running={sending || awaitingReply}
        followSignal={followSignal}
        leading={context}
      />
      {chat.archived ? null : (
        <view.Composer placeholder={t`Message this side chat`} sending={sending} onSend={send} />
      )}
    </div>
  );
}
