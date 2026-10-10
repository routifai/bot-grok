import { useLingui } from "@lingui/react/macro";
import { cn, Popover, PopoverContent, PopoverTrigger } from "@nova/ui-web";
import { MessagesSquare } from "lucide-react";
import { type ComponentProps, useState } from "react";
import { ChatTree } from "./MuseSidebar";

type TreeProps = Omit<ComponentProps<typeof ChatTree>, "collapsed">;

/**
 * The top bar's "Chats" button: the Conversation, its side chats and forks in a glass popover.
 * It replaces the sidebar; picking a row closes it.
 */
export function ChatsPopover({
  current,
  onOpenConversation,
  ...tree
}: TreeProps & {
  /** The Conversation itself is open (no side chat or fork). */
  current: boolean;
  onOpenConversation: () => void;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const close =
    <A extends unknown[]>(fn: (...args: A) => void) =>
    (...args: A) => {
      setOpen(false);
      fn(...args);
    };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        data-testid="chats-trigger"
        className="sc-glass app-no-drag inline-flex h-11 items-center gap-2 rounded-xl px-3.5 text-[14px] font-medium text-foreground transition-colors hover:bg-foreground/10 focus-visible:outline-2 focus-visible:outline-ring data-[popup-open]:bg-foreground/10"
      >
        <MessagesSquare size={18} strokeWidth={1.7} aria-hidden="true" />
        {t`Chats`}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        aria-label={t`Chats`}
        className="sc-glass rk-scroll max-h-[min(70vh,560px)] w-[min(340px,calc(100vw-2rem))] gap-0 overflow-y-auto rounded-[20px] bg-window/95 p-2 shadow-float ring-0"
      >
        <button
          type="button"
          onClick={close(onOpenConversation)}
          className={cn(
            "flex min-h-11 items-center gap-2.5 rounded-xl px-3 text-start text-[14px] font-medium text-foreground transition-colors hover:bg-foreground/10 focus-visible:outline-2 focus-visible:outline-ring",
            current && "bg-foreground/12",
          )}
        >
          {t`Conversation`}
        </button>
        <ChatTree
          {...tree}
          collapsed={false}
          onOpenChat={close(tree.onOpenChat)}
          onNewDraft={close(tree.onNewDraft)}
          onOpenFork={tree.onOpenFork ? close(tree.onOpenFork) : undefined}
          onShowForks={tree.onShowForks ? close(tree.onShowForks) : undefined}
        />
      </PopoverContent>
    </Popover>
  );
}
