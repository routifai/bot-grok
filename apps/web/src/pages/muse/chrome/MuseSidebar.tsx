import type { Goal, ThreadMessage } from "@aiden/contracts";
import { BotAvatar, cn, Tooltip, TooltipContent, TooltipTrigger } from "@aiden/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  Bell,
  Library,
  Lightbulb,
  MessageCircle,
  Newspaper,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Target,
} from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { MuseRailView as MuseView } from "../../../components/AppRail";
import { rpc } from "../../../lib/rpc";
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
  museName,
  color,
  runs,
  messages,
  personName,
  active,
  onNavigate,
  onOpenWaiting,
  onOpenSettings,
}: {
  botId: string;
  museName: string;
  color: string;
  runs: readonly MuseLiveRun[];
  messages: readonly ThreadMessage[] | undefined;
  personName?: string;
  active: MuseView;
  onNavigate: (view: MuseView) => void;
  onOpenWaiting: () => void;
  onOpenSettings: () => void;
}) {
  const { t } = useLingui();
  const {
    state: museState,
    label: activityLabel,
    askCount,
  } = useMuseLiveState({
    botId,
    runs,
    messages,
  });
  const [goals, setGoals] = useState<Goal[]>([]);
  const generation = useRef(0);
  const [collapsed, toggleCollapsed] = useSidebarCollapsed();
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
      current: active === "conversation",
      onClick: () => onNavigate("conversation"),
    },
    {
      key: "goals",
      icon: <Target />,
      label: t`Goals`,
      meta: activeGoals.length || undefined,
      current: active === "goals",
      onClick: () => onNavigate("goals"),
    },
    {
      key: "feed",
      icon: <Newspaper />,
      label: t`Feed`,
      current: active === "feed",
      onClick: () => onNavigate("feed"),
    },
    {
      key: "ideas",
      icon: <Lightbulb />,
      label: t`Ideas`,
      current: active === "ideas",
      onClick: () => onNavigate("ideas"),
    },
    {
      key: "library",
      icon: <Library />,
      label: t`Library`,
      current: active === "library",
      onClick: () => onNavigate("library"),
    },
    {
      key: "waiting",
      icon: <Bell />,
      label: t`Waiting on you`,
      meta: askCount || undefined,
      attention: askCount > 0,
      onClick: onOpenWaiting,
    },
  ];

  return (
    <nav
      data-testid="app-rail"
      data-collapsed={collapsed || undefined}
      aria-label={t`Sections`}
      className={cn(
        "group/rail app-drag flex shrink-0 flex-col gap-6 overflow-hidden px-3 pt-5 pb-4 transition-[width] duration-200 ease-out motion-reduce:transition-none",
        collapsed ? "w-[84px]" : "w-[320px]",
      )}
    >
      <button
        type="button"
        onClick={onOpenWaiting}
        aria-label={t`Waiting on you`}
        title={collapsed ? museName : undefined}
        className={cn(
          "app-no-drag flex w-full items-center gap-3.5 rounded-2xl border px-[7px] py-2 text-start transition-[background-color,border-color,box-shadow] duration-200 focus-visible:outline-2 focus-visible:outline-ring",
          collapsed
            ? "border-transparent bg-transparent"
            : "border-border bg-background shadow-sm hover:shadow-float",
        )}
      >
        <span className="shrink-0 transition-transform duration-300 ease-[cubic-bezier(.34,1.56,.64,1)] hover:scale-110 motion-reduce:transition-none">
          <BotAvatar
            color={color}
            identity={botId}
            museState={museState}
            face="muse"
            waitingCount={askCount}
            size={44}
          />
        </span>
        <span className={cn(LABEL, "block")}>
          <span className="block truncate text-[17px] font-semibold text-foreground" dir="auto">
            {museName}
          </span>
          {activityLabel ? (
            <span className="mt-0.5 flex items-center gap-1.5 text-[14px] text-muted-foreground">
              <span
                aria-hidden="true"
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  museState === "waiting"
                    ? "bg-warning"
                    : "animate-[rkPulse_2.4s_ease-in-out_infinite] bg-success",
                )}
              />
              <span className="truncate">{activityLabel}</span>
            </span>
          ) : null}
        </span>
      </button>

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
          <RailRow
            key={row.key}
            collapsed={collapsed}
            icon={row.icon}
            label={row.label}
            meta={row.meta}
            attention={row.attention}
            current={row.current}
            onClick={row.onClick}
            onMouseEnter={nav.onRowEnter}
          />
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
                <span className="shrink-0 text-[13px] tabular-nums text-muted-foreground">
                  {done}/{goal.tasks.length}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="app-no-drag mt-auto flex flex-col gap-0.5">
        <RailRow
          collapsed={collapsed}
          icon={collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
          label={collapsed ? t`Expand sidebar` : t`Collapse sidebar`}
          onClick={toggleCollapsed}
        />
        <RailRow
          collapsed={collapsed}
          icon={<Settings />}
          label={t`Settings`}
          onClick={onOpenSettings}
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
      ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
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
