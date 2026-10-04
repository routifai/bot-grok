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
import type { ChatListState } from "./useChatList";
import { type MuseLiveRun, useMuseLiveState } from "./useMuseLiveState";

const MAX_SIDEBAR_GOALS = 5;
const COLLAPSED_KEY = "muse:sidebar-collapsed";

// One layout for both states: the width animates and labels fade, so every icon keeps
// exactly the same position whether the sidebar is expanded or collapsed. Icon centers sit
// on one column (42px from the edge), which is also the avatar's center.
const ROW = "flex h-11 w-full items-center gap-4 rounded-xl ps-[19px] pe-3 text-start";
const LABEL =
  "min-w-0 flex-1 truncate whitespace-nowrap transition-opacity duration-150 group-data-[collapsed]/rail:pointer-events-none group-data-[collapsed]/rail:opacity-0";
const ICON_MOTION =
  "relative grid size-[22px] shrink-0 place-items-center transition-transform duration-300 ease-[cubic-bezier(.34,1.56,.64,1)] group-hover/row:-translate-y-0.5 group-hover/row:scale-[1.18] group-hover/row:-rotate-6 group-active/row:scale-95 motion-reduce:transition-none motion-reduce:transform-none [&_svg]:size-[22px] [&_svg]:stroke-[1.75]";

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
          "group/rail app-drag flex shrink-0 flex-col gap-6 overflow-hidden px-3 pt-5 pb-4",
          mobile
            ? "h-full w-full overflow-y-auto"
            : "hidden border border-glass-border bg-glass shadow-float backdrop-blur-xl transition-[width] duration-200 ease-out motion-reduce:transition-none md:flex md:rounded-2xl",
          !mobile && (collapsed ? "w-[84px]" : "w-[320px]"),
        )}
      >
        {/* Sections, chats and goals scroll together; the footer stays pinned below them. */}
        <div className="app-no-drag -mx-1 flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-1">
          <div ref={nav.listRef} className="app-no-drag relative flex flex-col gap-0.5">
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 top-0 rounded-xl bg-sidebar-accent/80 transition-[transform,height,opacity] duration-200 ease-out motion-reduce:transition-none"
              style={{
                height: nav.glide?.height ?? 44,
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
                  />
                ) : null}
              </Fragment>
            ))}
          </div>

          {activeGoals.length ? (
            <div
              aria-hidden={collapsed || undefined}
              className="app-no-drag flex min-h-0 flex-col gap-0.5 transition-opacity duration-150 group-data-[collapsed]/rail:pointer-events-none group-data-[collapsed]/rail:opacity-0"
            >
              <div className="ps-[19px] pb-2 text-[13.5px] font-semibold whitespace-nowrap text-muted-foreground">
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
                    className="flex items-center gap-3 rounded-xl ps-[26px] pe-3 py-2.5 text-start text-[15px] whitespace-nowrap text-sidebar-foreground/85 transition-colors hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "size-2 shrink-0 rounded-full",
                        waiting ? "bg-warning" : "bg-muted-foreground/40",
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate" dir="auto">
                      {goal.title}
                    </span>
                    {goal.tasks.length > 0 ? (
                      <span className="shrink-0 text-[13px] tabular-nums text-muted-foreground">
                        {done}/{goal.tasks.length}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>

        <div className="app-no-drag flex shrink-0 flex-col gap-0.5">
          {mobile ? null : (
            <RailRow
              collapsed={collapsed}
              icon={collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
              label={collapsed ? t`Expand sidebar` : t`Collapse sidebar`}
              onClick={toggleCollapsed}
            />
          )}
          <RailRow
            collapsed={collapsed}
            icon={<Settings />}
            label={t`Settings`}
            onClick={() => goOverlay(onOpenSettings)}
          />
          {personName ? (
            <div
              title={collapsed ? personName : undefined}
              className={cn(ROW, "mt-1 ps-[17px] text-[15.5px] text-sidebar-foreground")}
            >
              <span
                aria-hidden="true"
                className="grid size-[26px] shrink-0 place-items-center rounded-full bg-foreground text-[12.5px] font-semibold text-background"
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
          className="w-[min(86vw,320px)] gap-0 border-glass-border bg-glass p-0 backdrop-blur-xl md:hidden"
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

const TWIG_ROW =
  "flex h-[34px] w-full items-center gap-2 rounded-lg px-2.5 text-start text-[14px] whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-ring";

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
}: {
  state: ChatListState;
  collapsed: boolean;
  activeChatId: string | null;
  onOpenChat: (chat: ChatSummary) => void;
  onNewDraft: () => void;
}) {
  const [archivedOpen, setArchivedOpen] = useState(false);
  if (state.status !== "ready") return null;
  const sorted = [...state.chats].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  const live = sorted.filter((chat) => !chat.archived);
  const archived = sorted.filter((chat) => chat.archived);
  return (
    <div
      data-testid="chat-tree"
      aria-hidden={collapsed || undefined}
      className="app-no-drag relative ms-[26px] flex flex-col gap-0.5 border-s border-border/70 py-0.5 ps-3.5 transition-opacity duration-150 group-data-[collapsed]/rail:pointer-events-none group-data-[collapsed]/rail:opacity-0"
    >
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
              ? "bg-sidebar-accent font-medium text-foreground"
              : "text-sidebar-foreground/80 hover:bg-sidebar-accent",
          )}
        >
          <span className="min-w-0 flex-1 truncate" dir="auto">
            {chat.title}
          </span>
          {chat.live ? (
            <>
              <span
                aria-hidden="true"
                className="size-1.5 shrink-0 rounded-full animate-[rkPulse_2.4s_ease-in-out_infinite] bg-success"
              />
              <span className="sr-only">
                <Trans>Nova is working</Trans>
              </span>
            </>
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
          "gap-2 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
          activeChatId === "draft" && "bg-sidebar-accent text-foreground",
        )}
      >
        <Plus size={14} strokeWidth={1.75} className="shrink-0" />
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
            className={cn(TWIG_ROW, "gap-1.5 text-muted-foreground hover:bg-sidebar-accent")}
          >
            <ChevronRight
              size={13}
              className={cn("shrink-0 transition-transform", archivedOpen && "rotate-90")}
            />
            <span className="truncate">
              <Trans>Archived</Trans>
            </span>
            <span className="ms-auto shrink-0 text-[12px] tabular-nums">{archived.length}</span>
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
                    activeChatId === chat.id
                      ? "bg-sidebar-accent font-medium text-foreground"
                      : "text-muted-foreground hover:bg-sidebar-accent",
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

function RailRow({
  icon,
  label,
  meta,
  attention = false,
  current = false,
  collapsed,
  onClick,
  onMouseEnter,
}: {
  icon: ReactNode;
  label: string;
  meta?: number;
  attention?: boolean;
  current?: boolean;
  collapsed: boolean;
  onClick: () => void;
  onMouseEnter?: (event: MouseEvent<HTMLElement>) => void;
}) {
  const classes = cn(
    ROW,
    "group/row relative text-[16px] transition-colors focus-visible:outline-2 focus-visible:outline-ring",
    current
      ? "bg-primary/10 font-medium text-foreground"
      : "text-sidebar-foreground/80 hover:text-sidebar-foreground",
  );
  const content = (
    <>
      <span
        className={cn(
          ICON_MOTION,
          current ? "text-foreground" : "text-muted-foreground group-hover/row:text-foreground",
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
            "shrink-0 rounded-full px-2 py-0.5 text-[12.5px] font-medium tabular-nums",
            attention ? "bg-warning/15 text-warning" : "text-muted-foreground",
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
