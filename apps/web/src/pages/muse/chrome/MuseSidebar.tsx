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
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { ChevronRight, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { Fragment, useEffect, useRef, useState } from "react";
import type { MuseRailView as MuseView } from "../../../components/AppRail";
import { NovaOrb, useIsDesktop, useOrbHome } from "../../../components/ai/orb";
import { rpc } from "../../../lib/rpc";
import {
  FORK_TONE_CLASS,
  type ForkFilter,
  type ForkRow,
} from "../forks/forkModel";
import { LiveDot } from "../forks/forkParts";
import {
  ConversationGlyph,
  FeedGlyph,
  ForkGlyph,
  GoalsGlyph,
  IdeasGlyph,
  LibraryGlyph,
  SettingsGlyph,
  SidebarGlyph,
  WaitingGlyph,
} from "./NovaGlyphs";
import type { ChatListState } from "./useChatList";
import { type MuseLiveRun, useMuseLiveState } from "./useMuseLiveState";
import { useNovaWork } from "./useNovaWork";

const MAX_SIDEBAR_GOALS = 3;
const COLLAPSED_KEY = "muse:sidebar-collapsed";

// One layout for both states: the width animates and labels fade, so every icon keeps
// exactly the same position whether the sidebar is expanded or collapsed. Rows are 32px,
// 13px, a 17px glyph 10px in from the row's edge.
const ROW =
  "flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-start text-[13px] whitespace-nowrap";
const LABEL =
  "min-w-0 flex-1 truncate whitespace-nowrap transition-opacity duration-150 group-data-[collapsed]/rail:pointer-events-none group-data-[collapsed]/rail:opacity-0";
const FADE =
  "transition-opacity duration-150 group-data-[collapsed]/rail:pointer-events-none group-data-[collapsed]/rail:opacity-0";
/** A section's header in the sidebar ("Nova", "Side chats", "Open · 2", "Goals"). */
const GROUP_LABEL =
  "px-2.5 pt-3.5 pb-1 text-[11px] font-bold whitespace-nowrap text-ink-3";

/** Whether the person collapsed the desktop sidebar, remembered across sessions. The shell
 * owns it, since the orb's home depends on it (components/ai/orb/placement.tsx). */
export function useSidebarCollapsed() {
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

/** A count: a red capsule for what waits on the person, else a plain number in the secondary
 * ink (white on the selected row), the way Mail and Notes count in their sidebars. */
function Badge({
  count,
  tone = "quiet",
}: {
  count: number;
  tone?: "alert" | "quiet";
}) {
  return tone === "alert" ? (
    <span className="grid h-[18px] min-w-5 shrink-0 place-items-center rounded-full bg-alert px-1.5 text-[11.5px] font-semibold text-white tabular-nums">
      {count}
    </span>
  ) : (
    <span className="shrink-0 text-[12px] text-ink-3 tabular-nums group-aria-[current=page]/row:text-white/80 group-data-[collapsed]/rail:hidden">
      {count}
    </span>
  );
}

/** Nova at the top of the sidebar: the orb's home, the name, and what it is doing. While the
 * orb lives elsewhere (the start page, or the toolbar while collapsed) the slot keeps its size
 * empty, so nothing shifts when the orb lands here. */
function NovaIdentity({
  name,
  working,
  collapsed,
  hasOrb,
  onToggle,
}: {
  name: string;
  working: number;
  collapsed: boolean;
  hasOrb: boolean;
  onToggle?: () => void;
}) {
  const { t } = useLingui();
  const status = working
    ? plural(working, {
        one: "Working on # thing",
        other: "Working on # things",
      })
    : t`Ready`;
  return (
    <div className="flex items-center gap-2.5 px-0.5 pt-1 pb-2">
      {hasOrb ? (
        <NovaOrb size={34} />
      ) : (
        <span
          aria-hidden="true"
          data-testid="nova-orb-slot"
          className="size-[34px] shrink-0"
        />
      )}
      <div className={cn("min-w-0 flex-1", FADE)}>
        <p
          className="truncate text-[15px] font-semibold tracking-[-0.2px] text-foreground"
          dir="auto"
        >
          {name}
        </p>
        <p
          data-testid="nova-status"
          className="flex items-center gap-1.5 text-[11.5px] text-ink-3"
          aria-live="polite"
        >
          <span
            aria-hidden="true"
            className="size-1.5 shrink-0 rounded-full bg-ok"
          />
          <span className="truncate">{status}</span>
        </p>
      </div>
      {onToggle && !collapsed ? (
        <button
          type="button"
          onClick={onToggle}
          title={t`Collapse sidebar`}
          aria-label={t`Collapse sidebar`}
          className="grid size-7 shrink-0 place-items-center rounded-md text-ink-3 transition-colors hover:bg-selection hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring [&_svg]:size-4"
        >
          <SidebarGlyph />
        </button>
      ) : null}
    </div>
  );
}

/**
 * The Muse-mode sidebar (docs/muse/DESIGN.md "Sidebar"): a glass panel with Nova and what
 * it is doing, the Conversation with its side chats and forks, Nova's places, the active
 * Goals, and the person with Settings. Collapses to an icon rail.
 */
export function MuseSidebar({
  botId,
  museName = "Nova",
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
  collapsed: collapsedProp,
  onToggleCollapsed,
}: {
  /** The shell's collapsed state (`useSidebarCollapsed`); the sidebar keeps its own without it. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  botId: string;
  /** The name shown beside the orb. */
  museName?: string;
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
  const { askCount } = useMuseLiveState({ botId, runs, messages });
  const { count: working } = useNovaWork({ botId, runs, messages });
  const [goals, setGoals] = useState<Goal[]>([]);
  const generation = useRef(0);
  const [ownCollapsed, ownToggle] = useSidebarCollapsed();
  const desktopCollapsed = collapsedProp ?? ownCollapsed;
  const toggleCollapsed = onToggleCollapsed ?? ownToggle;
  const orbInSidebar = useOrbHome("sidebar");
  const isDesktop = useIsDesktop();

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

  const places: Array<{
    key: MuseView | "waiting";
    icon: ReactNode;
    /** The glyph's signature color (sig-* tokens). */
    tint: string;
    label: string;
    badge?: ReactNode;
    current?: boolean;
    onClick: () => void;
  }> = [
    {
      key: "goals",
      icon: <GoalsGlyph />,
      tint: "text-sig-goals",
      label: t`Goals`,
      badge: activeGoals.length ? (
        <Badge count={activeGoals.length} />
      ) : undefined,
      current: active === "goals",
      onClick: () => go(onNavigate, "goals"),
    },
    {
      key: "feed",
      icon: <FeedGlyph />,
      tint: "text-sig-feed",
      label: t`Feed`,
      current: active === "feed",
      onClick: () => go(onNavigate, "feed"),
    },
    {
      key: "ideas",
      icon: <IdeasGlyph />,
      tint: "text-sig-ideas",
      label: t`Ideas`,
      current: active === "ideas",
      onClick: () => go(onNavigate, "ideas"),
    },
    {
      key: "library",
      icon: <LibraryGlyph />,
      tint: "text-sig-library",
      label: t`Library`,
      current: active === "library",
      onClick: () => go(onNavigate, "library"),
    },
    {
      key: "waiting",
      icon: <WaitingGlyph />,
      tint: "text-sig-waiting",
      label: t`Waiting on you`,
      badge: askCount ? <Badge count={askCount} tone="alert" /> : undefined,
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
          "group/rail app-drag flex shrink-0 flex-col overflow-hidden px-2 pt-2.5 pb-2",
          mobile
            ? "h-full w-full overflow-y-auto"
            : "nova-glass m-2 hidden transition-[width] duration-200 ease-out motion-reduce:transition-none md:flex",
          !mobile && (collapsed ? "w-[54px]" : "w-[244px]"),
        )}
      >
        <NovaIdentity
          name={museName}
          working={working}
          collapsed={collapsed}
          hasOrb={orbInSidebar && !collapsed && mobile !== isDesktop}
          onToggle={mobile ? undefined : toggleCollapsed}
        />
        {/* Sections, chats and goals scroll together; the footer stays pinned below them. */}
        <div className="app-no-drag -mx-1 flex min-h-0 flex-1 flex-col overflow-y-auto px-1">
          <RailRow
            collapsed={collapsed}
            icon={<ConversationGlyph />}
            tint="text-tint"
            label={t`Conversation`}
            current={
              active === "conversation" && !activeChatId && !activeForkId
            }
            onClick={() => go(onNavigate, "conversation")}
          />
          <ChatTree
            state={chatListState}
            collapsed={collapsed}
            activeChatId={activeChatId ?? null}
            onOpenChat={(chat) => go(onOpenChat, chat)}
            onNewDraft={() => go(onNewDraft)}
            forks={forks}
            activeForkId={activeForkId}
            onOpenFork={onOpenFork ? (fork) => go(onOpenFork, fork) : undefined}
            onShowForks={
              onShowForks ? (filter) => go(onShowForks, filter) : undefined
            }
          />

          <div
            aria-hidden={collapsed || undefined}
            className={cn(GROUP_LABEL, FADE)}
          >
            <Trans>Nova</Trans>
          </div>
          <div className="flex flex-col gap-px">
            {places.map((row) => (
              <Fragment key={row.key}>
                <RailRow
                  collapsed={collapsed}
                  icon={row.icon}
                  tint={row.tint}
                  label={row.label}
                  badge={row.badge}
                  current={row.current}
                  onClick={row.onClick}
                />
              </Fragment>
            ))}
          </div>

          {activeGoals.length ? (
            <div
              aria-hidden={collapsed || undefined}
              className={cn("flex min-h-0 flex-col", FADE)}
            >
              <div className={GROUP_LABEL}>
                <Trans>Goals</Trans>
              </div>
              {activeGoals.slice(0, MAX_SIDEBAR_GOALS).map((goal) => {
                const done = goal.tasks.filter(
                  (task) => task.status === "done",
                ).length;
                const waiting =
                  goal.openProposal != null ||
                  goal.tasks.some((task) => task.status === "blocked");
                return (
                  <button
                    key={goal.id}
                    type="button"
                    tabIndex={collapsed ? -1 : undefined}
                    onClick={() => onNavigate("goals")}
                    className={cn(TWIG_ROW, "text-foreground", TWIG_HOVER)}
                  >
                    <GoalProgress
                      done={done}
                      total={goal.tasks.length}
                      waiting={waiting}
                    />
                    <span className="min-w-0 flex-1 truncate" dir="auto">
                      {goal.title}
                    </span>
                    {goal.tasks.length > 0 ? (
                      <span className="shrink-0 text-[11.5px] tabular-nums text-ink-3">
                        {done}/{goal.tasks.length}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>

        <div className="app-no-drag flex shrink-0 flex-col gap-px pt-2">
          {collapsed ? (
            <RailRow
              quiet
              collapsed
              icon={<SidebarGlyph />}
              label={t`Expand sidebar`}
              onClick={toggleCollapsed}
            />
          ) : null}
          <div className="flex items-center gap-1">
            {personName && !collapsed ? (
              <div className={cn(ROW, "min-w-0 flex-1 text-ink-2")}>
                <span
                  aria-hidden="true"
                  className="grid size-[22px] shrink-0 place-items-center rounded-full bg-linear-to-br from-tile-gray-from to-tile-gray-to text-[10px] font-semibold text-white"
                >
                  {personName.trim().charAt(0).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1 truncate" dir="auto">
                  {personName}
                </span>
              </div>
            ) : null}
            {collapsed || !personName ? (
              <RailRow
                quiet
                collapsed={collapsed}
                icon={<SettingsGlyph />}
                label={t`Settings`}
                onClick={() => goOverlay(onOpenSettings)}
              />
            ) : (
              <button
                type="button"
                onClick={() => goOverlay(onOpenSettings)}
                title={t`Settings`}
                aria-label={t`Settings`}
                className="grid size-8 shrink-0 place-items-center rounded-lg text-ink-2 transition-colors hover:bg-selection hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring [&_svg]:size-4"
              >
                <SettingsGlyph />
              </button>
            )}
          </div>
        </div>
      </nav>
    );
  };

  return (
    <>
      {renderNav(false)}
      <Sheet
        open={mobileOpen}
        onOpenChange={(open) => onMobileOpenChange?.(open)}
      >
        <SheetContent
          side="left"
          showCloseButton={false}
          className="nova-glass w-[min(86vw,320px)] gap-0 border-0 p-0 md:hidden"
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

// Rows under the Conversation (side chats, forks) and under Goals: 28px, a small 13px glyph,
// the same hover and selected fills everywhere.
const TWIG_ROW =
  "flex h-7 w-full items-center gap-2.5 rounded-lg ps-3 pe-2.5 text-start text-[13px] whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-ring";
const TWIG_HOVER = "hover:bg-selection";
const TWIG_SELECTED = "bg-tint text-white [&_svg]:text-white";

/** The quiet unread mark: a 7px accent dot (or the fork's own color). */
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

/** A Goal's progress as a tiny ring (done of total), or a plain dot when it has no plan yet.
 * Waiting on the person, it takes the waiting color. */
function GoalProgress({
  done,
  total,
  waiting,
}: {
  done: number;
  total: number;
  waiting: boolean;
}) {
  if (total === 0) {
    return (
      <span
        aria-hidden="true"
        className="grid size-3.5 shrink-0 place-items-center"
      >
        <span
          className={cn(
            "size-1.5 rounded-full",
            waiting ? "bg-sig-waiting" : "bg-ink-3",
          )}
        />
      </span>
    );
  }
  const radius = 5.5;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 14 14"
      className={cn(
        "size-3.5 shrink-0 -rotate-90",
        waiting ? "text-sig-waiting" : "text-sig-goals",
      )}
    >
      <circle
        cx="7"
        cy="7"
        r={radius}
        fill="none"
        strokeWidth="1.75"
        className="stroke-line"
      />
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
 * The Side Chats, under the Conversation row they branch from (agreed behavior #1): small
 * rows with a 13px glyph under a "Side chats" header, newest first, a pulsing dot while Nova is
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
      className={cn("app-no-drag relative flex flex-col gap-px", FADE)}
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
      {live.length ? (
        <div className={GROUP_LABEL}>
          <Trans>Side chats</Trans>
        </div>
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
              : cn(
                  TWIG_HOVER,
                  chat.unread
                    ? "font-medium text-foreground"
                    : "text-foreground",
                ),
          )}
        >
          <ConversationGlyph className="size-[13px] shrink-0 text-ink-3" />
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
          activeChatId === "draft"
            ? TWIG_SELECTED
            : cn("text-ink-2", TWIG_HOVER),
        )}
      >
        <Plus
          size={13}
          strokeWidth={2}
          aria-hidden="true"
          className="shrink-0"
        />
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
              size={13}
              strokeWidth={1.75}
              aria-hidden="true"
              className={cn(
                "shrink-0 transition-transform",
                archivedOpen && "rotate-90",
              )}
            />
            <span className="truncate">
              <Trans>Archived</Trans>
            </span>
            <span className="ms-auto shrink-0 text-[11.5px] tabular-nums text-ink-3">
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
                    "ps-[34px]",
                    activeChatId === chat.id
                      ? TWIG_SELECTED
                      : cn("text-ink-2", TWIG_HOVER),
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
        "group/row grid min-h-7 w-full grid-cols-[13px_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-0.5 rounded-lg ps-3 pe-2.5 py-1 text-start text-[13px] transition-colors focus-visible:outline-2 focus-visible:outline-ring",
        activeForkId === fork.chatId ? TWIG_SELECTED : TWIG_HOVER,
      )}
    >
      <ForkGlyph
        className={cn("size-[13px]", FORK_TONE_CLASS[fork.tone].text)}
      />
      <span
        className={cn(
          "truncate",
          activeForkId === fork.chatId ? "text-white" : "text-foreground",
        )}
        dir="auto"
      >
        {fork.title}
      </span>
      {fork.status === "live" ? (
        <LiveDot tone={fork.tone} className="size-1.5" />
      ) : fork.unread && activeForkId !== fork.chatId ? (
        <UnreadDot className={FORK_TONE_CLASS[fork.tone].bg} />
      ) : fork.replies ? (
        <Badge count={fork.replies} />
      ) : (
        <span />
      )}
      {fork.anchorText ? (
        <small
          className={cn(
            "col-start-2 col-end-4 truncate text-[11.5px]",
            activeForkId === fork.chatId ? "text-white/80" : "text-ink-3",
          )}
          dir="auto"
        >
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
        "flex w-full items-center justify-between rounded-lg pb-2 text-start transition-colors hover:text-ink-2 focus-visible:outline-2 focus-visible:outline-ring",
      )}
    >
      <span className="truncate">{label}</span>
      <span className="shrink-0 tabular-nums">{count}</span>
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
                "justify-between ps-[34px] text-ink-2",
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
  tint,
  label,
  badge,
  current = false,
  quiet = false,
  collapsed,
  onClick,
}: {
  icon: ReactNode;
  /** The glyph's color at rest (a section's signature color). */
  tint?: string;
  label: string;
  badge?: ReactNode;
  current?: boolean;
  /** The footer's rows (Expand, Settings): in the secondary ink. */
  quiet?: boolean;
  collapsed: boolean;
  onClick: () => void;
}) {
  const classes = cn(
    ROW,
    "group/row relative transition-colors focus-visible:outline-2 focus-visible:outline-ring",
    current
      ? "bg-tint font-medium text-white"
      : quiet
        ? "text-ink-2 hover:bg-selection hover:text-foreground"
        : "text-foreground hover:bg-selection",
  );
  const content = (
    <>
      <span
        className={cn(
          "relative grid size-[17px] shrink-0 place-items-center [&_svg]:size-[17px]",
          current ? "text-white" : (tint ?? "text-ink-2"),
        )}
      >
        {icon}
        {badge && collapsed ? (
          <span className="absolute -top-2 -end-2.5 scale-90">{badge}</span>
        ) : null}
      </span>
      <span className={LABEL}>{label}</span>
      {badge && !collapsed ? badge : null}
    </>
  );
  if (!collapsed) {
    return (
      <button
        type="button"
        onClick={onClick}
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
