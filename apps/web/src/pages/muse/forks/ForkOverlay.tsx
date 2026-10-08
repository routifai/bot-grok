import { ChatMarkdown } from "@aiden/chat-ui/web";
import type { ChatSummary, ThreadMessage } from "@aiden/contracts";
import { cn } from "@aiden/ui-web";
import { Trans } from "@lingui/react/macro";
import { ArrowLeft } from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useRef } from "react";
import { copyableMessageText } from "../../../lib/message-text";
import type { SideChatWire } from "../chrome/SideChatSession";

/** What the fork UI needs beyond a Side Chat's own wire (`chats.*`): kept as an explicit shape so
 * tests can supply fakes. */
export type ForkWire = SideChatWire & {
  createFork: (input: {
    botId: string;
    chatId?: string;
    anchorItemId: string;
    text: string;
  }) => Promise<ChatSummary>;
  addToConversation: (input: { botId: string; chatId: string }) => Promise<{ summary: string }>;
  archive: (input: { botId: string; chatId: string }) => Promise<{ ok: true }>;
};

/**
 * One fork moment over the Conversation, inside the chat panel: the chat blurs behind a scrim
 * and this sits on top. Escape (or a click on the scrim) goes back; focus returns to whatever
 * opened it.
 */
export function ForkOverlay({
  label,
  onClose,
  scrollRef,
  initialFocusRef,
  children,
}: {
  label: string;
  onClose: () => void;
  scrollRef?: RefObject<HTMLDivElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => initialFocusRef?.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      if (opener?.isConnected) opener.focus();
    };
  }, [initialFocusRef]);
  return (
    <div
      ref={scrollRef}
      role="dialog"
      aria-label={label}
      data-testid="fork-overlay"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.stopPropagation();
          closeRef.current();
        }
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) closeRef.current();
      }}
      className="absolute inset-0 z-30 overflow-y-auto bg-ground/65 backdrop-blur-md backdrop-saturate-110 animate-[forkFade_220ms_cubic-bezier(.2,.8,.2,1)_both] motion-reduce:animate-none"
    >
      {children}
    </div>
  );
}

/** The overlay's top row: "← Conversation", then whatever the moment adds. */
export function OverlayTopBar({
  onClose,
  backRef,
  children,
}: {
  onClose: () => void;
  backRef?: RefObject<HTMLButtonElement | null>;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-[13px] text-ink-2">
      <button
        ref={backRef}
        type="button"
        onClick={onClose}
        className="inline-flex h-7 items-center gap-1.5 rounded-full border border-line bg-card px-3 text-[12.5px] font-medium text-ink-2 transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        <ArrowLeft size={13} strokeWidth={1.75} aria-hidden="true" />
        <Trans>Conversation</Trans>
      </button>
      {children}
    </div>
  );
}

/** The message a fork starts from, lifted out of the Conversation onto a solid card. */
export function LiftedMessage({
  message,
  className,
}: {
  message: ThreadMessage;
  className?: string;
}) {
  const text = copyableMessageText(message);
  return (
    <div
      data-testid="fork-origin"
      className={cn(
        "max-h-[40vh] overflow-y-auto rounded-[20px] bg-card px-4 py-3.5 text-[15px] leading-[1.6] text-foreground shadow-float animate-[forkLift_320ms_cubic-bezier(.2,.8,.2,1)_both] motion-reduce:animate-none",
        className,
      )}
      dir="auto"
    >
      {message.role === "user" ? (
        <p className="m-0 whitespace-pre-wrap wrap-anywhere">{text}</p>
      ) : (
        <ChatMarkdown>{text}</ChatMarkdown>
      )}
    </div>
  );
}
