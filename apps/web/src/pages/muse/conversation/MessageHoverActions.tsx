import { Trans, useLingui } from "@lingui/react/macro";
import type { ThreadMessage } from "@nova/contracts";
import { canReactToThreadMessage, MESSAGE_REACTIONS, type MessageReaction } from "@nova/contracts";
import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@nova/ui-web";
import { Check, Copy, MoreHorizontal, Reply, Smile } from "lucide-react";
import { type ReactNode, useState } from "react";
import { MessageHoverMetadata } from "../../../components/MessageHoverMetadata";
import { copyableMessageText } from "../../../lib/message-text";
import { BranchIcon } from "../forks/forkParts";

export function MessageHoverActions({
  message,
  side,
  time,
  onReply,
  onReact,
  onFork,
  above = Boolean(onFork),
  conversational = true,
}: {
  message: ThreadMessage;
  side: "start" | "end";
  /** The send time, shown beside the actions so it stays next to the bubble. */
  time?: ReactNode;
  onReply?: (message: ThreadMessage) => void;
  onReact: (message: ThreadMessage, reaction: MessageReaction) => Promise<void>;
  /** Team-chat actions (reactions, reply threads); a one-on-one Muse keeps just More. */
  conversational?: boolean;
  /** Fork this message (ADR 0010); the actions then float above the bubble as a toolbar. */
  onFork?: (message: ThreadMessage) => void;
  /** Float above the bubble even without Fork, to match the messages around it that have it. */
  above?: boolean;
}) {
  const { t } = useLingui();
  const [moreOpen, setMoreOpen] = useState(false);
  const [reactionsOpen, setReactionsOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  // Streaming progress bubbles keep hover free for selection / stop clicks.
  if (message.id.startsWith("progress:")) return null;

  function copyMessage() {
    const text = copyableMessageText(message);
    if (!text || !navigator.clipboard) return;
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  }

  const iconButtonClass =
    "grid h-7 w-7 place-items-center text-muted-foreground transition-colors hover:text-foreground";

  return (
    <MessageHoverMetadata pinned={moreOpen || reactionsOpen} side={side} above={above}>
      {time}
      <div data-testid="message-hover-actions" className="flex items-center gap-0.5">
        {conversational && canReactToThreadMessage(message) ? (
          <Popover open={reactionsOpen} onOpenChange={setReactionsOpen}>
            <PopoverTrigger
              aria-label={t`React`}
              className={cn(
                iconButtonClass,
                "h-11 w-11 [@media(hover:hover)_and_(pointer:fine)]:h-7 [@media(hover:hover)_and_(pointer:fine)]:w-7",
              )}
            >
              <Smile size={15} strokeWidth={1.7} />
            </PopoverTrigger>
            <PopoverContent
              align={side === "end" ? "start" : "end"}
              className="w-auto flex-row gap-0 rounded-2xl p-1.5"
              aria-label={t`Reactions`}
            >
              {MESSAGE_REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  aria-label={emoji}
                  className="grid h-11 w-11 place-items-center rounded-xl text-2xl hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={() => {
                    setReactionsOpen(false);
                    void onReact(message, emoji);
                  }}
                >
                  {emoji}
                </button>
              ))}
            </PopoverContent>
          </Popover>
        ) : null}
        {conversational && onReply ? (
          <button
            type="button"
            aria-label={t`Reply`}
            onClick={() => onReply(message)}
            className={`${iconButtonClass} hidden [@media(hover:hover)_and_(pointer:fine)]:grid`}
          >
            <Reply size={15} strokeWidth={1.7} />
          </button>
        ) : null}
        <button
          type="button"
          aria-label={copied ? t`Copied` : t`Copy`}
          onClick={copyMessage}
          className={cn(
            iconButtonClass,
            "h-11 w-11 [@media(hover:hover)_and_(pointer:fine)]:h-7 [@media(hover:hover)_and_(pointer:fine)]:w-7",
          )}
        >
          {copied ? <Check size={15} strokeWidth={1.7} /> : <Copy size={14} strokeWidth={1.7} />}
        </button>
        {onFork ? (
          <button
            type="button"
            title={t`Fork`}
            aria-label={t`Fork`}
            onClick={() => onFork(message)}
            className={cn(
              iconButtonClass,
              "h-11 w-11 [@media(hover:hover)_and_(pointer:fine)]:h-7 [@media(hover:hover)_and_(pointer:fine)]:w-7",
            )}
          >
            <BranchIcon size={15} />
          </button>
        ) : null}
        {onReply ? (
          <DropdownMenu open={moreOpen} onOpenChange={setMoreOpen}>
            <DropdownMenuTrigger
              aria-label={t`More`}
              className={cn(
                iconButtonClass,
                "h-11 w-11 [@media(hover:hover)_and_(pointer:fine)]:hidden",
              )}
            >
              <MoreHorizontal size={15} strokeWidth={1.7} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align={side === "end" ? "start" : "end"}>
              <DropdownMenuItem onClick={() => onReply(message)}>
                <Reply size={15} />
                <Trans>Reply</Trans>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </MessageHoverMetadata>
  );
}
