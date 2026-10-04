import { ChatMarkdown } from "@aiden/chat-ui/web";
import type {
  ChatSummary,
  SideChatStart,
  ThreadMessage,
  ThreadMessagePage,
} from "@aiden/contracts";
import { Button, Switch, Textarea, Tooltip, TooltipContent, TooltipTrigger } from "@aiden/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { ArrowUp, ChevronRight, X } from "lucide-react";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";
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

/** A Side Chat shown as a full-size session (agreed behavior #2): either an unsent
 * draft or an existing chat, replacing the Conversation entirely while open. */
export function SideChatSession({
  botId,
  chat,
  wire,
  onCreated,
  onClose,
}: {
  botId: string;
  /** "draft": not created yet. Otherwise the chat being viewed (possibly archived). */
  chat: ChatSummary | "draft";
  wire: SideChatWire;
  /** The draft just sent its first message and became a real chat. */
  onCreated: (chat: ChatSummary) => void;
  onClose: () => void;
}) {
  if (chat === "draft") {
    return <DraftSideChat botId={botId} wire={wire} onCreated={onCreated} onClose={onClose} />;
  }
  return <ExistingSideChat key={chat.id} chat={chat} wire={wire} onClose={onClose} />;
}

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
    <div className="app-drag flex items-center gap-3 border-b border-glass-border px-4 py-3.5 md:px-6">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[16px] font-semibold text-foreground" dir="auto">
          {title}
        </div>
        {meta}
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label={t`Back to the conversation`}
        className="app-no-drag grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <X size={16} strokeWidth={1.75} />
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

function MessageComposer({
  placeholder,
  sending,
  onSend,
}: {
  placeholder: string;
  sending: boolean;
  onSend: (text: string) => void;
}) {
  const { t } = useLingui();
  const [draft, setDraft] = useState("");
  const canSend = draft.trim().length > 0 && !sending;

  const submit = () => {
    if (!canSend) return;
    onSend(draft.trim());
    setDraft("");
  };

  return (
    <form
      className="mx-4 mb-4 flex items-end gap-2 rounded-[22px] border border-border bg-card px-3 py-2 shadow-sm md:mx-6"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        submit();
      }}
    >
      <Textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
        placeholder={placeholder}
        rows={1}
        className="max-h-40 min-h-9 flex-1 resize-none border-0 bg-transparent px-1.5 py-1.5 shadow-none focus-visible:ring-0"
      />
      <Button
        type="submit"
        size="icon"
        aria-label={t`Send`}
        className="rounded-full"
        disabled={!canSend}
      >
        <ArrowUp size={16} strokeWidth={2} />
      </Button>
    </form>
  );
}

function DraftSideChat({
  botId,
  wire,
  onCreated,
  onClose,
}: {
  botId: string;
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
      .summaryPreview({ botId })
      .then(({ summary }) => {
        if (!cancelled) setPreview(summary);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [botId, wire]);

  const send = (text: string) => {
    setSending(true);
    void wire
      .createSide({ botId, start: knows ? "withContext" : "blank", text })
      .then(onCreated)
      .catch(() => setSending(false));
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SessionHeader title={t`New side chat`} onClose={onClose} />
      <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        <h2 className="text-[19px] font-semibold tracking-[-0.01em] text-foreground">
          <Trans>What do you want to look at?</Trans>
        </h2>
      </div>
      <div className="mb-2.5 flex justify-center px-4">
        <Tooltip>
          <TooltipTrigger
            type="button"
            role="switch"
            aria-checked={knows}
            onClick={() => setKnows((value) => !value)}
            className="inline-flex h-8 items-center gap-2.5 rounded-full border border-border bg-card px-1 pe-3 text-[13.5px] text-foreground"
          >
            <Switch checked={knows} onCheckedChange={setKnows} size="sm" tabIndex={-1} />
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
      <MessageComposer placeholder={t`Message this side chat`} sending={sending} onSend={send} />
    </div>
  );
}

const REPLY_POLL_INTERVAL_MS = 3000;
const REPLY_POLL_MAX_MS = 3 * 60 * 1000;

function ExistingSideChat({
  chat,
  wire,
  onClose,
}: {
  chat: ChatSummary;
  wire: SideChatWire;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [messages, setMessages] = useState<ThreadMessage[] | null>(null);
  const [sending, setSending] = useState(false);
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
    void wire
      .send({ chatId: chat.id, text })
      .then(() =>
        wire
          .messages({ chatId: chat.id })
          .then((page) => setMessages(page.messages))
          .catch(() => undefined),
      )
      .finally(() => setSending(false));
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SessionHeader
        title={chat.title}
        meta={
          chat.archived ? (
            <span className="text-[12.5px] text-muted-foreground">
              <Trans>Archived</Trans>
            </span>
          ) : undefined
        }
        onClose={onClose}
      />
      <div className="flex-1 overflow-y-auto px-4 py-5 md:px-6">
        <div className="mx-auto flex max-w-[720px] flex-col gap-5">
          {chat.start === "blank" ? (
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
          )}
          {messages?.map((message) => (
            <MessageRow key={message.id} message={message} />
          ))}
        </div>
      </div>
      {chat.archived ? null : (
        <MessageComposer placeholder={t`Message this side chat`} sending={sending} onSend={send} />
      )}
    </div>
  );
}
