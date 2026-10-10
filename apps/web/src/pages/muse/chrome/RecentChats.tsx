import { Trans, useLingui } from "@lingui/react/macro";
import type { ChatSummary } from "@nova/contracts";
import { cn } from "@nova/ui-web";
import { ChevronDown, ChevronUp, Plus, Search } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import {
  FORK_TONE_CLASS,
  type ForkFilter,
  type ForkRow,
} from "../../../features/side-chats/forkModel";
import { LiveDot } from "../../../features/side-chats/forkParts";
import type { ChatListState } from "../../../features/side-chats/useChatList";
import { formatRelativeTime } from "../../../lib/relative-time";

const ROW =
  "flex w-full items-center gap-2.5 rounded-xl p-2.5 text-start transition-colors hover:bg-foreground/10 focus-visible:outline-2 focus-visible:outline-ring";
const ROW_ON = "bg-foreground/[0.07]";
const SECTION = "px-1.5 pt-2 pb-0.5 text-[12.5px] font-semibold text-ink-2";
/** Open forks shown before the rest fold into "N more open". */
const MAX_OPEN_FORKS = 4;

function UnreadDot({ className }: { className?: string }) {
  return (
    <>
      <span
        aria-hidden="true"
        className={cn("size-[7px] shrink-0 rounded-full bg-tint", className)}
      />
      <span className="sr-only">
        <Trans>Unread</Trans>
      </span>
    </>
  );
}

/** A row of the panel: a title over a quiet line, with a status mark on the right. */
function Row({
  title,
  line,
  mark,
  current,
  onClick,
}: {
  title: string;
  line?: string;
  mark?: ReactNode;
  current?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={current ? "page" : undefined}
      className={cn(ROW, current && ROW_ON)}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[14px] font-medium text-foreground" dir="auto">
          {title}
        </span>
        {line ? (
          <span className="truncate text-[12.5px] text-ink-2" dir="auto">
            {line}
          </span>
        ) : null}
      </span>
      {mark}
    </button>
  );
}

/**
 * Recent chats, a glass panel on the home: the one Conversation, then its forks and its side
 * chats (newest first), with a search over all of them and a button for a new side chat.
 * Nothing but the Conversation renders while the chats wire can't be reached.
 */
export function RecentChats({
  state,
  conversationCurrent,
  conversationWorking,
  activeChatId,
  onOpenConversation,
  onOpenChat,
  onNewDraft,
  forks = [],
  activeForkId = null,
  onOpenFork,
  onShowForks,
  className,
}: {
  state: ChatListState;
  /** The Conversation itself is open (not a side chat or a fork). */
  conversationCurrent: boolean;
  conversationWorking: boolean;
  /** The open Side Chat, or "draft" for an unsent one. */
  activeChatId: string | null;
  onOpenConversation: () => void;
  onOpenChat: (chat: ChatSummary) => void;
  onNewDraft: () => void;
  forks?: readonly ForkRow[];
  activeForkId?: string | null;
  onOpenFork?: (fork: ForkRow) => void;
  onShowForks?: (filter: ForkFilter) => void;
  className?: string;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(true);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [query, setQuery] = useState("");
  const needle = query.trim().toLocaleLowerCase();
  const matches = (...texts: (string | null | undefined)[]) =>
    !needle || texts.some((text) => text?.toLocaleLowerCase().includes(needle));

  // Forks are listed by state; the rest are plain Side Chats, newest first.
  const sorted =
    state.status === "ready"
      ? [...state.chats]
          .filter((chat) => !chat.anchorItemId)
          .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      : [];
  const chats = sorted.filter((chat) => matches(chat.title));
  const live = chats.filter((chat) => !chat.archived);
  const archived = chats.filter((chat) => chat.archived);
  const shownForks = forks.filter((fork) => matches(fork.title, fork.anchorText));
  const working = shownForks.filter((fork) => fork.status === "live");
  const openForks = shownForks.filter((fork) => fork.status === "open");
  const added = shownForks.filter((fork) => fork.status === "added");
  const searching = needle !== "";
  const conversationTitle = t`Conversation`;
  const showConversation = matches(conversationTitle);
  const nothing =
    searching && !showConversation && !live.length && !archived.length && !shownForks.length;

  const chatRow = (chat: ChatSummary) => (
    <Row
      key={chat.id}
      title={chat.title}
      line={
        chat.live ? t`Working` : chat.unread ? t`New reply` : formatRelativeTime(chat.updatedAt)
      }
      current={activeChatId === chat.id}
      onClick={() => onOpenChat(chat)}
      mark={
        chat.live ? (
          <LiveDot className="size-2" />
        ) : chat.unread && activeChatId !== chat.id ? (
          <UnreadDot />
        ) : null
      }
    />
  );
  const forkRow = (fork: ForkRow) => (
    <Row
      key={fork.chatId}
      title={fork.title}
      line={fork.anchorText ? t`from “${fork.anchorText}”` : formatRelativeTime(fork.updatedAt)}
      current={activeForkId === fork.chatId}
      onClick={() => onOpenFork?.(fork)}
      mark={
        fork.status === "live" ? (
          <LiveDot tone={fork.tone} className="size-2" />
        ) : fork.unread && activeForkId !== fork.chatId ? (
          <UnreadDot className={FORK_TONE_CLASS[fork.tone].bg} />
        ) : null
      }
    />
  );
  const fold = (label: string, count: number, filter: ForkFilter) => (
    <button
      type="button"
      onClick={() => onShowForks?.(filter)}
      className={cn(ROW, "justify-between text-[13px] text-ink-2")}
    >
      <span className="truncate">{label}</span>
      <span className="shrink-0 tabular-nums">{count}</span>
    </button>
  );

  return (
    <section
      data-testid="recent-chats"
      aria-label={t`Recent chats`}
      className={cn(
        "sc-glass flex w-full flex-col gap-1.5 rounded-[20px] p-3.5 md:w-[360px]",
        className,
      )}
    >
      <div className="flex items-center justify-between">
        <span className="ps-1.5 text-[12.5px] font-semibold text-ink-2">
          <Trans>Recent</Trans>
        </span>
        <button
          type="button"
          aria-label={open ? t`Collapse recent chats` : t`Expand recent chats`}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="grid size-8 place-items-center rounded-xl text-foreground transition-colors hover:bg-foreground/10 focus-visible:outline-2 focus-visible:outline-ring"
        >
          {open ? (
            <ChevronDown size={16} aria-hidden="true" />
          ) : (
            <ChevronUp size={16} aria-hidden="true" />
          )}
        </button>
      </div>
      {open ? (
        <>
          <div
            data-testid="chat-tree"
            className="rk-scroll flex max-h-[min(34vh,320px)] flex-col gap-0.5 overflow-y-auto"
          >
            {showConversation ? (
              <Row
                title={conversationTitle}
                line={conversationWorking ? t`Working` : undefined}
                current={conversationCurrent}
                onClick={onOpenConversation}
                mark={conversationWorking ? <LiveDot className="size-2" /> : null}
              />
            ) : null}
            {onOpenFork && onShowForks ? (
              <div data-testid="fork-groups" className="flex flex-col gap-0.5">
                {working.length ? (
                  <>
                    <div className={SECTION}>{t`Working · ${working.length}`}</div>
                    {working.map(forkRow)}
                  </>
                ) : null}
                {openForks.length ? (
                  <>
                    <div className={SECTION}>{t`Open · ${openForks.length}`}</div>
                    {(searching ? openForks : openForks.slice(0, MAX_OPEN_FORKS)).map(forkRow)}
                    {!searching && openForks.length > MAX_OPEN_FORKS
                      ? fold(t`${openForks.length - MAX_OPEN_FORKS} more open`, 0, "open")
                      : null}
                  </>
                ) : null}
                {added.length
                  ? searching
                    ? added.map(forkRow)
                    : fold(t`Added to Conversation`, added.length, "added")
                  : null}
              </div>
            ) : null}
            {live.length ? <div className={SECTION}>{t`Side chats`}</div> : null}
            {live.map(chatRow)}
            {archived.length ? (
              <>
                <button
                  type="button"
                  aria-expanded={archivedOpen || searching}
                  onClick={() => setArchivedOpen((value) => !value)}
                  className={cn(ROW, "justify-between text-[13px] text-ink-2")}
                >
                  <span className="truncate">
                    <Trans>Archived</Trans>
                  </span>
                  <span className="shrink-0 tabular-nums">{archived.length}</span>
                </button>
                {archivedOpen || searching ? archived.map(chatRow) : null}
              </>
            ) : null}
            {activeChatId === "draft" ? (
              <Row title={t`New side chat`} current onClick={onNewDraft} />
            ) : null}
            {nothing ? (
              <p className="px-2.5 py-2 text-[13px] text-ink-2">
                <Trans>No chats match.</Trans>
              </p>
            ) : null}
          </div>
          <div className="mt-1 flex items-center gap-2">
            <button
              type="button"
              aria-label={t`New side chat`}
              title={t`New side chat`}
              onClick={onNewDraft}
              className="grid size-11 shrink-0 place-items-center rounded-xl text-foreground transition-colors hover:bg-foreground/10 focus-visible:outline-2 focus-visible:outline-ring"
            >
              <Plus size={20} strokeWidth={1.8} aria-hidden="true" />
            </button>
            <div className="relative flex-1">
              <label className="sr-only" htmlFor="recent-chats-search">
                <Trans>Search chats</Trans>
              </label>
              <Search
                size={16}
                strokeWidth={2}
                aria-hidden="true"
                className="pointer-events-none absolute start-3.5 top-3.5 text-ink-2"
              />
              <input
                id="recent-chats-search"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t`Search chats`}
                className="min-h-11 w-full rounded-xl border border-glass-line bg-black/20 ps-10 pe-3.5 text-[14px] text-foreground placeholder:text-ink-2 focus-visible:outline-2 focus-visible:outline-ring"
              />
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}
