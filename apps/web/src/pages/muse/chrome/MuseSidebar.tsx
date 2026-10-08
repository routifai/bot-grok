import type { ChatSummary, Goal, ThreadMessage } from "@aiden/contracts";
import {
  cn,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@aiden/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  Bell,
  ChevronRight,
  Library,
  Lightbulb,
  MessageCircle,
  Newspaper,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings,
  Target,
} from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { Fragment, useEffect, useRef, useState } from "react";
import type { MuseRailView as MuseView } from "../../../components/AppRail";
import { rpc } from "../../../lib/rpc";
import { FORK_TONE_CLASS, type ForkFilter, type ForkRow } from "../forks/forkModel";
import { BranchIcon, LiveDot } from "../forks/forkParts";
import type { ChatListState } from "./useChatList";
import { type MuseLiveRun, useMuseLiveState } from "./useMuseLiveState";

const MAX_SIDEBAR_GOALS = 3;
const COLLAPSED_KEY = "muse:sidebar-collapsed";

// One layout for both states: the width animates and labels fade, so every icon keeps
// exactly the same position whether the sidebar is expanded or collapsed. Icon centers sit
// on one column (42px from the edge), which is also the avatar's center.
const ROW = "flex h-10 w-full items-center gap-3.5 rounded-xl ps-[19px] pe-3 text-start";
const LABEL =
  "min-w-0 flex-1 truncate whitespace-nowrap transition-opacity duration-150 group-data-[collapsed]/rail:pointer-events-none group-data-[collapsed]/rail:opacity-0";
const ICON_MOTION =
  "relative grid size-[22px] shrink-0 place-items-center transition-transform duration-300 ease-[cubic-bezier(.34,1.56,.64,1)] group-hover/row:-translate-y-0.5 group-hover/row:scale-[1.18] group-hover/row:-rotate-6 group-active/row:scale-95 motion-reduce:transition-none motion-reduce:transform-none [&_svg]:size-5 [&_svg]:stroke-[1.75]";

function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggle = () =>
    setCollapsed((current) => {
      const next = !current;
      try {
        localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        // Remembering the choice is a convenience; the toggle still works.
      }
      return next;
    });
  return [collapsed, toggle] as const;
}

/** A pill that glides to whichever row the pointer is over (hidden when none). */
function useGlide() {
  const listRef = useRef<HTMLDivElement>(null);
  const [glide, setGlide] = useState<{ top: number; height: number } | null>(null);
  const onRowEnter = (event: MouseEvent<HTMLElement>) => {
    const list = listRef.current;
    if (!list) return;
    const row = event.currentTarget.getBoundingClientRect();
    const box = list.getBoundingClientRect();
    // Rects are in zoomed pixels; convert back to layout pixels for the transform.
    const scale = box.height / list.offsetHeight || 1;
    setGlide({ top: (row.top - box.top) / scale, height: row.height / scale });
  };
  // Hide the pill when the pointer leaves the list (listener, not a handler on a div).
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const hide = () => setGlide(null);
    list.addEventListener("mouseleave", hide);
    return () => list.removeEventListener("mouseleave", hide);
  }, []);
  return { listRef, glide, onRowEnter };
}

/**
 * The Muse-mode sidebar (docs/muse/DESIGN.md "Sidebar"): Aiden and what he's doing, the
 * four places, what's waiting, the active Goals, and settings. Collapses to an icon rail.
 */
export function MuseSidebar({
  botId,
  runs,
  messages,
  personName,
  active,
  activeChatId,
  chatListState,
  onNavigate,
  onOpenWaiting,
  onOpenSettings,
  onOpenChat,
  onNewDraft,
  forks = [],
  activeForkId = null,
  onOpenFork,
  onShowForks,
  mobileOpen = false,
  onMobileOpenChange,
}: {
  botId: string;
  runs: readonly MuseLiveRun[];
  messages: readonly ThreadMessage[] | undefined;
  personName?: string;
  active: MuseView;
  /** The open Side Chat, or "draft" for an unsent one; null while viewing the Conversation. */
  activeChatId?: string | null;
  /** The Chat List wire (`useChatList`), owned by the shell so the open session's own
   * create can refresh the same list this sidebar renders. */
  chatListState: ChatListState;
  onNavigate: (view: MuseView) => void;
  onOpenWaiting: () => void;
  onOpenSettings: () => void;
  /** Replaces the Conversation with this Side Chat as a full-size session. */
  onOpenChat: (chat: ChatSummary) => void;
  /** Opens an empty, unsent Side Chat draft. */
  onNewDraft: () => void;
  /** The Conversation's forks (ADR 0010), listed under it by state. */
  forks?: readonly ForkRow[];
  /** The fork open in the thread view. */
  activeForkId?: string | null;
  onOpenFork?: (fork: ForkRow) => void;
  /** Opens the All forks list with this filter. */
  onShowForks?: (filter: ForkFilter) => void;
  /** Below `md` the sidebar is an off-canvas drawer; the shell owns whether it is open. */
  mobileOpen?: boolean;
  onMobileOpenChange?: (open: boolean) => void;
}) {
  const { t } = useLingui();
  // Only the Ask count is needed here — the Muse's face, name, and busy caption now live
  // once, in the context panel's identity header (ContextPanel.tsx's `IdentityHeader`).
  const { askCount } = useMuseLiveState({ botId, runs, messages });
  const [goals, setGoals] = useState<Goal[]>([]);
  const generation = useRef(0);
  const [desktopCollapsed, toggleCollapsed] = useSidebarCollapsed();
  const nav = useGlide();

  useEffect(() => {
    const current = ++generation.current;
    const load = () =>
      void rpc.goals
        .list({ botId })
        .then((list) => {
          if (current === generation.current) setGoals(list);
        })
        .catch(() => undefined);
    load();
    const timer = window.setInterval(load, 30_000);
    return () => {
      generation.current += 1;
      window.clearInterval(timer);
    };
  }, [botId]);

  const closeDrawer = () => onMobileOpenChange?.(false);
  const go = <A extends unknown[]>(fn: (...args: A) => void, ...args: A) => {
    fn(...args);
    closeDrawer();
  };

  // Settings and the Waiting sheet are modals of their own: opening one while the drawer is
  // still mounted loses it to the drawer's focus handling, so they open once it has left.
  const goOverlay = (fn: () => void) => {
    if (!mobileOpen) return fn();
    closeDrawer();
    window.setTimeout(fn, 220);
  };

  const activeGoals = goals.filter((goal) => goal.status === "active");

  const rows: Array<{
    key: string;
    icon: ReactNode;
    label: string;
    meta?: number;
    attention?: boolean;
    current?: boolean;
    onClick: () => void;
  }> = [
    {
      key: "conversation",
      icon: <MessageCircle />,
      label: t`Conversation`,
      current: active === "conversation" && !activeChatId,
      onClick: () => go(onNavigate, "conversation"),
    },
    {
      key: "goals",
      icon: <Target />,
      label: t`Goals`,
      meta: activeGoals.length || undefined,
      current: active === "goals",
      onClick: () => go(onNavigate, "goals"),
    },
    {
      key: "feed",
      icon: <Newspaper />,
      label: t`Feed`,
      current: active === "feed",
      onClick: () => go(onNavigate, "feed"),
    },
    {
      key: "ideas",
      icon: <Lightbulb />,
      label: t`Ideas`,
      current: active === "ideas",
      onClick: () => go(onNavigate, "ideas"),
    },
    {
      key: "library",
      icon: <Library />,
      label: t`Library`,
      current: active === "library",
      onClick: () => go(onNavigate, "library"),
    },
    {
      key: "waiting",
      icon: <Bell />,
      label: t`Waiting on you`,
      meta: askCount || undefined,
      attention: askCount > 0,
      onClick: () => goOverlay(onOpenWaiting),
    },
  ];

  const renderNav = (mobile: boolean) => {
    const collapsed = !mobile && desktopCollapsed;
    return (
      <nav
        data-testid={mobile ? "app-rail-drawer" : "app-rail"}
        data-collapsed={collapsed || undefined}
        aria-label={t`Sections`}
        className={cn(
          "group/rail app-drag flex shrink-0 flex-col gap-6 overflow-hidden px-3 pt-3.5 pb-3",
          mobile
            ? "h-full w-full overflow-y-auto"
            : "hidden border border-line bg-panel backdrop-blur-xl transition-[width] duration-200 ease-out motion-reduce:transition-none md:flex md:rounded-[18px]",
          !mobile && (collapsed ? "w-[84px]" : "w-[288px]"),
        )}
      >
        {/* Sections, chats and goals scroll together; the footer stays pinned below them. */}
        <div className="app-no-drag -mx-1 flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-1">
          <div ref={nav.listRef} className="app-no-drag relative flex flex-col gap-0.5">
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 top-0 rounded-xl bg-selection/70 transition-[transform,height,opacity] duration-200 ease-out motion-reduce:transition-none"
              style={{
                height: nav.glide?.height ?? 40,
                transform: `translateY(${nav.glide?.top ?? 0}px)`,
                opacity: nav.glide ? 1 : 0,
              }}
            />
            {rows.map((row) => (
              <Fragment key={row.key}>
                <RailRow
                  collapsed={collapsed}
                  icon={row.icon}
                  label={row.label}
                  meta={row.meta}
                  attention={row.attention}
                  current={row.current}
                  onClick={row.onClick}
                  onMouseEnter={nav.onRowEnter}
                />
                {row.key === "conversation" ? (
                  <ChatTree
                    state={chatListState}
                    collapsed={collapsed}
                    activeChatId={activeChatId ?? null}
                    onOpenChat={(chat) => go(onOpenChat, chat)}
                    onNewDraft={() => go(onNewDraft)}
                    forks={forks}
                    activeForkId={activeForkId}
                    onOpenFork={onOpenFork ? (fork) => go(onOpenFork, fork) : undefined}
                    onShowForks={onShowForks ? (filter) => go(onShowForks, filter) : undefined}
                  />
                ) : null}
              </Fragment>
            ))}
          </div>

          {activeGoals.length ? (
            <div
              aria-hidden={collapsed || undefined}
              className="app-no-drag flex min-h-0 flex-col transition-opacity duration-150 group-data-[collapsed]/rail:pointer-events-none group-data-[collapsed]/rail:opacity-0"
            >
              <div className={cn(GROUP_LABEL, "ps-[19px]")}>
                <Trans>Goals</Trans>
              </div>
              {activeGoals.slice(0, MAX_SIDEBAR_GOALS).map((goal) => {
                const done = goal.tasks.filter((task) => task.status === "done").length;
                const waiting =
                  goal.openProposal != null || goal.tasks.some((task) => task.status === "blocked");
                return (
                  <button
                    key={goal.id}
                    type="button"
                    tabIndex={collapsed ? -1 : undefined}
                    onClick={() => onNavigate("goals")}
                    className={cn(
                      TWIG_ROW,
                      "gap-[18px] ps-[23px] pe-3 text-foreground/85 hover:bg-selection/70 hover:text-foreground",
                    )}
                  >
                    <GoalProgress done={done} total={goal.tasks.length} waiting={waiting} />
                    <span className="min-w-0 flex-1 truncate" dir="auto">
                      {goal.title}
                    </span>
                    {goal.tasks.length > 0 ? (
                      <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-ink-3">
                        {done}/{goal.tasks.length}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>

        <div className="app-no-drag flex shrink-0 flex-col">
          {mobile ? null : (
            <RailRow
              quiet
              collapsed={collapsed}
              icon={collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
              label={collapsed ? t`Expand sidebar` : t`Collapse sidebar`}
              onClick={toggleCollapsed}
            />
          )}
          <RailRow
            quiet
            collapsed={collapsed}
            icon={<Settings />}
            label={t`Settings`}
            onClick={() => goOverlay(onOpenSettings)}
          />
          {personName ? (
            <div
              title={collapsed ? personName : undefined}
              className={cn(ROW, "mt-1 h-9 ps-[20px] text-[14px] text-ink-2")}
            >
              <span
                aria-hidden="true"
                className="grid size-5 shrink-0 place-items-center rounded-full bg-selection text-[11px] font-semibold text-foreground"
              >
                {personName.trim().charAt(0).toUpperCase()}
              </span>
              <span className={LABEL} dir="auto">
                {personName}
              </span>
            </div>
          ) : null}
        </div>
      </nav>
    );
  };

  return (
    <>
      {renderNav(false)}
      <Sheet open={mobileOpen} onOpenChange={(open) => onMobileOpenChange?.(open)}>
        <SheetContent
          side="left"
          showCloseButton={false}
          className="w-[min(86vw,320px)] gap-0 border-line bg-panel p-0 backdrop-blur-xl md:hidden"
        >
          <SheetTitle className="sr-only">
            <Trans>Sections</Trans>
          </SheetTitle>
          <SheetDescription className="sr-only">
            <Trans>Navigate</Trans>
          </SheetDescription>
          {renderNav(true)}
        </SheetContent>
      </Sheet>
    </>
  );
}

// Rows under the Conversation (forks, Side Chats) and under Goals: 32px tall on the 4pt grid,
// a 14px lead (icon or ring) on one left edge, the same hover and selected fills everywhere.
const TWIG_ROW =
  "flex h-8 w-full items-center gap-2 rounded-[10px] px-2 text-start text-[13.5px] whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-ring";
const TWIG_HOVER = "hover:bg-selection/70 hover:text-foreground";
const TWIG_SELECTED = "bg-selection font-medium text-foreground";
/** A group's label in the sidebar ("Open · 2", "Added to Conversation", "Goals"). */
const GROUP_LABEL = "px-2 pt-2 pb-1 text-[11.5px] font-semibold whitespace-nowrap text-ink-3";

/** The quiet unread mark: a 6px dot, never heavy black. */
function UnreadDot({ className }: { className?: string }) {
  return (
    <>
      <span
        aria-hidden="true"
        className={cn("size-1.5 shrink-0 rounded-full bg-ink-2", className)}
      />
      <span className="sr-only">
        <Trans>Unread</Trans>
      </span>
    </>
  );
}

/** A Goal's progress as a tiny ring (done of total), or a plain dot when it has no plan yet.
 * Waiting on the person, it takes the warning token. */
function GoalProgress({ done, total, waiting }: { done: number; total: number; waiting: boolean }) {
  if (total === 0) {
    return (
      <span aria-hidden="true" className="grid size-3.5 shrink-0 place-items-center">
        <span className={cn("size-1.5 rounded-full", waiting ? "bg-warning" : "bg-ink-3")} />
      </span>
    );
  }
  const radius = 5.5;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 14 14"
      className={cn("size-3.5 shrink-0 -rotate-90", waiting ? "text-warning" : "text-ink-2")}
    >
      <circle cx="7" cy="7" r={radius} fill="none" strokeWidth="1.75" className="stroke-line" />
      <circle
        cx="7"
        cy="7"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeDasharray={`${(done / total) * circumference} ${circumference}`}
        className={done === 0 ? "opacity-0" : undefined}
      />
    </svg>
  );
}

/**
 * The Side Chats, nested under the Conversation row they branch from (agreed behavior
 * #1): a small tree with a connector line, newest first, a pulsing dot while Nova is
 * working in one, a "New side chat" row, and a collapsed-by-default Archived fold.
 * Nothing renders while the chats wire can't be reached (NOT_IMPLEMENTED): no heading,
 * no disabled button.
 */
export function ChatTree({
  state,
  collapsed,
  activeChatId,
  onOpenChat,
  onNewDraft,
  forks = [],
  activeForkId = null,
  onOpenFork,
  onShowForks,
}: {
  state: ChatListState;
  collapsed: boolean;
  activeChatId: string | null;
  onOpenChat: (chat: ChatSummary) => void;
  onNewDraft: () => void;
  forks?: readonly ForkRow[];
  activeForkId?: string | null;
  onOpenFork?: (fork: ForkRow) => void;
  onShowForks?: (filter: ForkFilter) => void;
}) {
  const [archivedOpen, setArchivedOpen] = useState(false);
  if (state.status !== "ready") return null;
  // Forks are listed by state above; the rest are plain Side Chats, listed as before.
  const sorted = [...state.chats]
    .filter((chat) => !chat.anchorItemId)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  const live = sorted.filter((chat) => !chat.archived);
  const archived = sorted.filter((chat) => chat.archived);
  return (
    <div
      data-testid="chat-tree"
      aria-hidden={collapsed || undefined}
      className="app-no-drag relative ms-[30px] flex flex-col border-s border-line py-1 ps-2.5 transition-opacity duration-150 group-data-[collapsed]/rail:pointer-events-none group-data-[collapsed]/rail:opacity-0"
    >
      {onOpenFork && onShowForks ? (
        <ForkGroups
          forks={forks}
          collapsed={collapsed}
          activeForkId={activeForkId}
          onOpenFork={onOpenFork}
          onShowForks={onShowForks}
        />
      ) : null}
      {live.map((chat) => (
        <button
          key={chat.id}
          type="button"
          tabIndex={collapsed ? -1 : undefined}
          onClick={() => onOpenChat(chat)}
          aria-current={activeChatId === chat.id ? "page" : undefined}
          className={cn(
            TWIG_ROW,
            activeChatId === chat.id
              ? TWIG_SELECTED
              : cn(TWIG_HOVER, chat.unread ? "font-medium text-foreground" : "text-foreground/85"),
          )}
        >
          <MessageCircle
            size={14}
            strokeWidth={1.75}
            aria-hidden="true"
            className="shrink-0 text-ink-3"
          />
          <span className="min-w-0 flex-1 truncate" dir="auto">
            {chat.title}
          </span>
          {chat.live ? (
            <LiveDot className="size-1.5" />
          ) : chat.unread && activeChatId !== chat.id ? (
            <UnreadDot />
          ) : null}
        </button>
      ))}
      <button
        type="button"
        tabIndex={collapsed ? -1 : undefined}
        onClick={onNewDraft}
        aria-current={activeChatId === "draft" ? "page" : undefined}
        className={cn(
          TWIG_ROW,
          activeChatId === "draft" ? TWIG_SELECTED : cn("text-ink-2", TWIG_HOVER),
        )}
      >
        <Plus size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
        <span className="truncate">
          <Trans>New side chat</Trans>
        </span>
      </button>
      {archived.length ? (
        <>
          <button
            type="button"
            tabIndex={collapsed ? -1 : undefined}
            onClick={() => setArchivedOpen((value) => !value)}
            aria-expanded={archivedOpen}
            className={cn(TWIG_ROW, "text-ink-2", TWIG_HOVER)}
          >
            <ChevronRight
              size={14}
              strokeWidth={1.75}
              aria-hidden="true"
              className={cn("shrink-0 transition-transform", archivedOpen && "rotate-90")}
            />
            <span className="truncate">
              <Trans>Archived</Trans>
            </span>
            <span className="ms-auto shrink-0 font-mono text-[11.5px] tabular-nums text-ink-3">
              {archived.length}
            </span>
          </button>
          {archivedOpen
            ? archived.map((chat) => (
                <button
                  key={chat.id}
                  type="button"
                  tabIndex={collapsed ? -1 : undefined}
                  onClick={() => onOpenChat(chat)}
                  aria-current={activeChatId === chat.id ? "page" : undefined}
                  className={cn(
                    TWIG_ROW,
                    "ps-[30px]",
                    activeChatId === chat.id ? TWIG_SELECTED : cn("text-ink-2", TWIG_HOVER),
                  )}
                >
                  <span className="min-w-0 flex-1 truncate" dir="auto">
                    {chat.title}
                  </span>
                </button>
              ))
            : null}
        </>
      ) : null}
    </div>
  );
}

/** Open forks shown before the rest fold into "N more open". */
const MAX_OPEN_FORKS = 4;

/**
 * The Conversation's forks in the sidebar (ADR 0010): the ones Nova is working in, then the open
 * ones (a few, then a link to the rest), then the finished ones folded into counts that open the
 * All forks list. Nothing renders without forks.
 */
function ForkGroups({
  forks,
  collapsed,
  activeForkId,
  onOpenFork,
  onShowForks,
}: {
  forks: readonly ForkRow[];
  collapsed: boolean;
  activeForkId: string | null;
  onOpenFork: (fork: ForkRow) => void;
  onShowForks: (filter: ForkFilter) => void;
}) {
  const { t } = useLingui();
  const working = forks.filter((fork) => fork.status === "live");
  const open = forks.filter((fork) => fork.status === "open");
  const added = forks.filter((fork) => fork.status === "added").length;
  // Archived forks live in the All forks list, not in a second "Archived" fold here.
  if (!working.length && !open.length && !added) return null;
  const tab = collapsed ? -1 : undefined;
  const heading = (label: string) => <div className={GROUP_LABEL}>{label}</div>;
  const row = (fork: ForkRow) => (
    <button
      key={fork.chatId}
      type="button"
      tabIndex={tab}
      onClick={() => onOpenFork(fork)}
      aria-current={activeForkId === fork.chatId ? "page" : undefined}
      className={cn(
        "grid min-h-8 w-full grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 rounded-[10px] px-2 py-1.5 text-start text-[13.5px] transition-colors focus-visible:outline-2 focus-visible:outline-ring",
        activeForkId === fork.chatId ? "bg-selection" : "hover:bg-selection/70",
      )}
    >
      <BranchIcon className={FORK_TONE_CLASS[fork.tone].text} />
      <span className="truncate font-medium text-foreground" dir="auto">
        {fork.title}
      </span>
      {fork.status === "live" ? (
        <LiveDot tone={fork.tone} className="size-1.5" />
      ) : fork.unread && activeForkId !== fork.chatId ? (
        <UnreadDot className={FORK_TONE_CLASS[fork.tone].bg} />
      ) : (
        <span />
      )}
      {fork.anchorText ? (
        <small className="col-start-2 col-end-4 truncate text-[12px] text-ink-3" dir="auto">
          {t`from “${fork.anchorText}”`}
        </small>
      ) : null}
    </button>
  );
  // A folded group reads as its label: same size and ink as "Open · N", a little brighter on
  // hover since it opens the All forks list.
  const fold = (label: string, count: number, filter: ForkFilter) => (
    <button
      type="button"
      tabIndex={tab}
      onClick={() => onShowForks(filter)}
      className={cn(
        GROUP_LABEL,
        "flex w-full items-center justify-between rounded-[10px] pb-2 text-start transition-colors hover:text-ink-2 focus-visible:outline-2 focus-visible:outline-ring",
      )}
    >
      <span className="truncate">{label}</span>
      <span className="shrink-0 font-mono tabular-nums">{count}</span>
    </button>
  );
  return (
    <div data-testid="fork-groups" className="flex flex-col pb-1">
      {working.length ? (
        <>
          {heading(t`Working · ${working.length}`)}
          {working.map(row)}
        </>
      ) : null}
      {open.length ? (
        <>
          {heading(t`Open · ${open.length}`)}
          {open.slice(0, MAX_OPEN_FORKS).map(row)}
          {open.length > MAX_OPEN_FORKS ? (
            <button
              type="button"
              tabIndex={tab}
              onClick={() => onShowForks("open")}
              className={cn(
                TWIG_ROW,
                "justify-between ps-[30px] text-[13px] text-ink-2",
                TWIG_HOVER,
              )}
            >
              <span className="truncate">{t`${open.length - MAX_OPEN_FORKS} more open`}</span>
              <span aria-hidden="true" className="text-ink-3">
                →
              </span>
            </button>
          ) : null}
        </>
      ) : null}
      {added ? fold(t`Added to Conversation`, added, "added") : null}
    </div>
  );
}

function RailRow({
  icon,
  label,
  meta,
  attention = false,
  current = false,
  quiet = false,
  collapsed,
  onClick,
  onMouseEnter,
}: {
  icon: ReactNode;
  label: string;
  meta?: number;
  attention?: boolean;
  current?: boolean;
  /** The footer's rows (Collapse, Settings): shorter, smaller, in the secondary ink. */
  quiet?: boolean;
  collapsed: boolean;
  onClick: () => void;
  onMouseEnter?: (event: MouseEvent<HTMLElement>) => void;
}) {
  const classes = cn(
    ROW,
    "group/row relative transition-colors focus-visible:outline-2 focus-visible:outline-ring",
    quiet
      ? "h-9 text-[14px] text-ink-2 hover:bg-selection/70 hover:text-foreground"
      : "text-[15px] font-medium",
    !quiet &&
      (current ? "bg-selection text-foreground" : "text-foreground/85 hover:text-foreground"),
  );
  const content = (
    <>
      <span
        className={cn(
          ICON_MOTION,
          quiet && "[&_svg]:size-[18px]",
          current
            ? "text-foreground"
            : quiet
              ? "text-ink-3 group-hover/row:text-foreground"
              : "text-ink-2 group-hover/row:text-foreground",
        )}
      >
        {icon}
        {meta && collapsed ? (
          <span
            className={cn(
              "absolute -top-2 -end-2.5 grid h-4 min-w-4 place-items-center rounded-full px-1 text-[10px] font-semibold tabular-nums",
              attention ? "bg-warning text-background" : "bg-foreground text-background",
            )}
          >
            {meta}
          </span>
        ) : null}
      </span>
      <span className={LABEL}>{label}</span>
      {meta && !collapsed ? (
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 font-mono text-[12px] font-medium tabular-nums",
            attention ? "bg-warning/15 text-warning" : "text-ink-3",
          )}
        >
          {meta}
        </span>
      ) : null}
    </>
  );
  if (!collapsed) {
    return (
      <button
        type="button"
        onClick={onClick}
        onMouseEnter={onMouseEnter}
        aria-current={current ? "page" : undefined}
        className={classes}
      >
        {content}
      </button>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger
        onClick={onClick}
        onMouseEnter={onMouseEnter}
        aria-label={label}
        aria-current={current ? "page" : undefined}
        className={classes}
      >
        {content}
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={12} className="text-[13px]">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
