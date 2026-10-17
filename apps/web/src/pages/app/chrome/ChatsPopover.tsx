import { useLingui } from "@lingui/react/macro";
import type { ChatSummary } from "@superchat/contracts";
import { cn, Popover, PopoverContent, PopoverTrigger } from "@superchat/ui-web";
import { Archive, ArchiveRestore, MessagesSquare, Plus } from "lucide-react";
import { type ReactNode, useState } from "react";
import {
  FORK_TONE_CLASS,
  type ForkFilter,
  type ForkRow,
} from "../../../features/side-chats/forkModel";
import type { ChatListState } from "../../../features/side-chats/useChatList";
import { rpc } from "../../../lib/rpc";

type Tab = "chats" | "forks" | "archived";

const ROW =
  "group flex min-h-11 w-full items-center gap-2.5 rounded-xl px-3 text-start text-[14px] text-foreground transition-colors hover:bg-foreground/10 focus-visible:outline-2 focus-visible:outline-ring";
const ICON_BUTTON =
  "grid size-8 shrink-0 place-items-center rounded-lg text-ink-2 opacity-0 transition hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring group-hover:opacity-100";

function Dot({ live, unread }: { live?: boolean; unread?: boolean }) {
  if (live)
    return <span className="size-2 shrink-0 rounded-full bg-tint-ink motion-safe:animate-pulse" />;
  if (unread) return <span className="size-2 shrink-0 rounded-full bg-tint" />;
  return null;
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-3 py-6 text-center text-[13px] text-ink-3">{children}</p>;
}

/**
 * The top bar's "Chats" button: the Conversation, its side chats, forks and archived ones in a
 * glass popover. It replaces the sidebar; picking a row closes it.
 */
export function ChatsPopover({
  botId,
  state,
  forks,
  current,
  activeChatId,
  onOpenConversation,
  onOpenChat,
  onNewDraft,
  onOpenFork,
  onShowForks,
  onChanged,
}: {
  botId: string;
  state: ChatListState;
  forks: readonly ForkRow[];
  /** The Conversation itself is open (no side chat or fork). */
  current: boolean;
  activeChatId: string | null;
  onOpenConversation: () => void;
  onOpenChat: (chat: ChatSummary) => void;
  onNewDraft: () => void;
  onOpenFork: (fork: ForkRow) => void;
  onShowForks: (filter: ForkFilter) => void;
  /** A chat was archived or restored: the list re-reads. */
  onChanged: () => void;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("chats");
  const [busy, setBusy] = useState<string | null>(null);
  const close =
    <A extends unknown[]>(fn: (...args: A) => void) =>
    (...args: A) => {
      setOpen(false);
      fn(...args);
    };

  const chats = state.status === "ready" ? state.chats.filter((chat) => !chat.anchorItemId) : [];
  const sorted = [...chats].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  const live = sorted.filter((chat) => !chat.archived);
  const archivedChats = sorted.filter((chat) => chat.archived);
  const openForks = forks.filter((fork) => fork.status !== "archived");
  const archivedForks = forks.filter((fork) => fork.status === "archived");

  const toggleArchive = async (chatId: string, archived: boolean) => {
    setBusy(chatId);
    try {
      await (archived ? rpc.chats.unarchive : rpc.chats.archive)({ botId, chatId });
      onChanged();
    } finally {
      setBusy(null);
    }
  };

  const archiveButton = (chatId: string, archived: boolean, title: string) => (
    <button
      type="button"
      disabled={busy === chatId}
      aria-label={archived ? t`Restore ${title}` : t`Archive ${title}`}
      title={archived ? t`Restore` : t`Archive`}
      onClick={(event) => {
        event.stopPropagation();
        void toggleArchive(chatId, archived);
      }}
      className={ICON_BUTTON}
    >
      {archived ? (
        <ArchiveRestore size={16} strokeWidth={1.8} />
      ) : (
        <Archive size={16} strokeWidth={1.8} />
      )}
    </button>
  );

  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: "chats", label: t`Side chats`, count: live.length },
    { key: "forks", label: t`Forks`, count: openForks.length },
    { key: "archived", label: t`Archived`, count: archivedChats.length + archivedForks.length },
  ];

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
        className="sc-glass w-[min(380px,calc(100vw-2rem))] gap-2 rounded-[20px] bg-window/95 p-2 shadow-float ring-0"
      >
        <button
          type="button"
          onClick={close(onOpenConversation)}
          aria-current={current ? "page" : undefined}
          className={cn(ROW, "font-medium", current && "bg-foreground/12")}
        >
          <MessagesSquare
            size={16}
            strokeWidth={1.8}
            aria-hidden="true"
            className="text-tint-ink"
          />
          {t`Conversation`}
        </button>
        <div role="tablist" aria-label={t`Chats`} className="flex gap-1 rounded-xl bg-black/20 p-1">
          {tabs.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={tab === item.key}
              onClick={() => setTab(item.key)}
              className={cn(
                "flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded-lg text-[13px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                tab === item.key
                  ? "bg-foreground/14 text-foreground"
                  : "text-ink-2 hover:text-foreground",
              )}
            >
              {item.label}
              {item.count ? <span className="text-ink-3 tabular-nums">{item.count}</span> : null}
            </button>
          ))}
        </div>
        <div
          role="tabpanel"
          className="rk-scroll -mx-1 flex max-h-[min(56vh,440px)] flex-col gap-px overflow-y-auto px-1"
        >
          {tab === "chats" ? (
            <>
              {live.map((chat) => (
                <div
                  key={chat.id}
                  className={cn(ROW, "pe-1.5", activeChatId === chat.id && "bg-foreground/12")}
                >
                  <button
                    type="button"
                    onClick={close(() => onOpenChat(chat))}
                    className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 text-start focus-visible:outline-none"
                  >
                    <span
                      className={cn("min-w-0 flex-1 truncate", chat.unread && "font-semibold")}
                      dir="auto"
                    >
                      {chat.title}
                    </span>
                    <Dot live={chat.live} unread={chat.unread} />
                  </button>
                  {archiveButton(chat.id, false, chat.title)}
                </div>
              ))}
              <button type="button" onClick={close(onNewDraft)} className={cn(ROW, "text-ink-2")}>
                <Plus size={16} strokeWidth={2} aria-hidden="true" />
                {t`New side chat`}
              </button>
            </>
          ) : null}
          {tab === "forks" ? (
            openForks.length ? (
              <>
                {openForks.map((fork) => (
                  <div key={fork.chatId} className={ROW}>
                    <button
                      type="button"
                      onClick={close(() => onOpenFork(fork))}
                      className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 text-start focus-visible:outline-none"
                    >
                      <span
                        aria-hidden="true"
                        className={cn("h-7 w-1 shrink-0 rounded", FORK_TONE_CLASS[fork.tone].bg)}
                      />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className={cn("truncate", fork.unread && "font-semibold")} dir="auto">
                          {fork.title}
                        </span>
                        {fork.anchorText ? (
                          <span className="truncate text-[12.5px] text-ink-3" dir="auto">
                            {fork.anchorText}
                          </span>
                        ) : null}
                      </span>
                    </button>
                    {archiveButton(fork.chatId, false, fork.title)}
                  </div>
                ))}
                <button
                  type="button"
                  onClick={close(() => onShowForks("all"))}
                  className={cn(ROW, "text-ink-2")}
                >
                  {t`All forks`}
                </button>
              </>
            ) : (
              <Empty>{t`Fork any message to explore it on the side.`}</Empty>
            )
          ) : null}
          {tab === "archived" ? (
            archivedChats.length || archivedForks.length ? (
              <>
                {[
                  ...archivedChats.map((chat) => ({
                    id: chat.id,
                    title: chat.title,
                    open: () => onOpenChat(chat),
                  })),
                  ...archivedForks.map((fork) => ({
                    id: fork.chatId,
                    title: fork.title,
                    open: () => onOpenFork(fork),
                  })),
                ].map((row) => (
                  <div key={row.id} className={ROW}>
                    <button
                      type="button"
                      onClick={close(row.open)}
                      className="flex min-h-11 min-w-0 flex-1 items-center text-start text-ink-2 focus-visible:outline-none"
                    >
                      <span className="truncate" dir="auto">
                        {row.title}
                      </span>
                    </button>
                    {archiveButton(row.id, true, row.title)}
                  </div>
                ))}
              </>
            ) : (
              <Empty>{t`Nothing archived.`}</Empty>
            )
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
