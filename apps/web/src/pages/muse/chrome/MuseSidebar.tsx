import { Trans, useLingui } from "@lingui/react/macro";
import type { Goal } from "@rakazo/contracts";
import { BotAvatar, cn, Tooltip, TooltipContent, TooltipTrigger } from "@rakazo/ui-web";
import {
  Bell,
  Library,
  MessageCircle,
  Newspaper,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Target,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { MuseRailView as MuseView } from "../../../components/AppRail";
import { rpc } from "../../../lib/rpc";
import { useAsks } from "../asks";
import { deriveStatusPill } from "./statusPill";

const MAX_SIDEBAR_GOALS = 5;
const COLLAPSED_KEY = "muse:sidebar-collapsed";

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

/**
 * The Muse-mode sidebar (docs/muse/DESIGN.md "Sidebar"): sits on the gray window
 * canvas next to the white content panel. Aiden and what he's doing on top, the four
 * places, what's waiting on the person, the active Goals, and settings at the bottom.
 */
export function MuseSidebar({
  botId,
  museName,
  color,
  status,
  running,
  personName,
  active,
  onNavigate,
  onOpenWaiting,
  onOpenSettings,
}: {
  botId: string;
  museName: string;
  color: string;
  status?: string;
  running: boolean;
  personName?: string;
  active: MuseView;
  onNavigate: (view: MuseView) => void;
  onOpenWaiting: () => void;
  onOpenSettings: () => void;
}) {
  const { t } = useLingui();
  const { count: askCount } = useAsks(botId);
  const [goals, setGoals] = useState<Goal[]>([]);
  const generation = useRef(0);

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

  const [collapsed, toggleCollapsed] = useSidebarCollapsed();
  const pill = deriveStatusPill({ museName, goals, running, openAskCount: askCount });
  const activeGoals = goals.filter((goal) => goal.status === "active");

  return (
    <nav
      data-testid="app-rail"
      data-collapsed={collapsed || undefined}
      aria-label={t`Sections`}
      className={cn(
        "app-drag flex shrink-0 flex-col gap-7 pt-5 pb-4 transition-[width,padding] duration-200 ease-out motion-reduce:transition-none",
        collapsed ? "w-[76px] items-center px-3" : "w-[320px] px-4",
      )}
    >
      <div
        className={cn(
          "app-no-drag flex gap-2",
          collapsed ? "flex-col items-center" : "items-start",
        )}
      >
        {collapsed ? (
          <RailTip label={t`Waiting on you`}>
            <TooltipTrigger
              onClick={onOpenWaiting}
              aria-label={t`Waiting on you`}
              className="group rounded-full transition-transform duration-300 ease-[cubic-bezier(.34,1.56,.64,1)] hover:scale-110 focus-visible:outline-2 focus-visible:outline-ring motion-reduce:transition-none"
            >
              <BotAvatar
                color={color}
                identity={botId}
                status={status}
                face="muse"
                waitingCount={askCount}
                size={44}
              />
            </TooltipTrigger>
          </RailTip>
        ) : (
          <button
            type="button"
            onClick={onOpenWaiting}
            aria-label={t`Waiting on you`}
            className="flex min-w-0 flex-1 items-center gap-3.5 rounded-2xl border border-border bg-background px-3.5 py-3 text-start shadow-sm transition-shadow hover:shadow-float focus-visible:outline-2 focus-visible:outline-ring"
          >
            <BotAvatar
              color={color}
              identity={botId}
              status={status}
              face="muse"
              waitingCount={askCount}
              size={44}
            />
            <span className="min-w-0">
              <span className="block truncate text-[17px] font-semibold text-foreground" dir="auto">
                {museName}
              </span>
              <span className="mt-0.5 flex items-center gap-1.5 text-[14px] text-muted-foreground">
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    pill.tone === "attention" && "bg-warning",
                    pill.tone === "live" &&
                      "animate-[rkPulse_2.4s_ease-in-out_infinite] bg-success",
                    pill.tone === "neutral" && "bg-muted-foreground/50",
                  )}
                />
                <span className="truncate">{sidebarStatus(pill.tone, askCount, t)}</span>
              </span>
            </span>
          </button>
        )}
        <RailTip label={collapsed ? t`Expand sidebar` : t`Collapse sidebar`}>
          <TooltipTrigger
            onClick={toggleCollapsed}
            aria-label={collapsed ? t`Expand sidebar` : t`Collapse sidebar`}
            className="group grid size-9 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            {collapsed ? (
              <PanelLeftOpen size={19} strokeWidth={1.75} />
            ) : (
              <PanelLeftClose size={19} strokeWidth={1.75} />
            )}
          </TooltipTrigger>
        </RailTip>
      </div>

      <div className={cn("app-no-drag flex flex-col gap-0.5", collapsed && "items-center")}>
        <NavRow
          collapsed={collapsed}
          icon={<MessageCircle />}
          label={<Trans>Conversation</Trans>}
          tip={t`Conversation`}
          active={active === "conversation"}
          onClick={() => onNavigate("conversation")}
        />
        <NavRow
          collapsed={collapsed}
          icon={<Target />}
          label={<Trans>Goals</Trans>}
          tip={t`Goals`}
          meta={activeGoals.length ? String(activeGoals.length) : undefined}
          active={active === "goals"}
          onClick={() => onNavigate("goals")}
        />
        <NavRow
          collapsed={collapsed}
          icon={<Newspaper />}
          label={<Trans>Feed</Trans>}
          tip={t`Feed`}
          active={active === "feed"}
          onClick={() => onNavigate("feed")}
        />
        <NavRow
          collapsed={collapsed}
          icon={<Library />}
          label={<Trans>Library</Trans>}
          tip={t`Library`}
          active={active === "library"}
          onClick={() => onNavigate("library")}
        />
        <NavRow
          collapsed={collapsed}
          icon={<Bell />}
          label={<Trans>Waiting on you</Trans>}
          tip={t`Waiting on you`}
          meta={askCount ? String(askCount) : undefined}
          attention={askCount > 0}
          onClick={onOpenWaiting}
        />
      </div>

      {activeGoals.length && !collapsed ? (
        <div className="app-no-drag flex min-h-0 flex-col gap-0.5">
          <div className="px-3.5 pb-2 text-[13.5px] font-semibold text-muted-foreground">
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
                onClick={() => onNavigate("goals")}
                className="flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-start text-[15px] text-sidebar-foreground/85 transition-colors hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-ring"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
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

      <div className={cn("app-no-drag mt-auto flex flex-col gap-0.5", collapsed && "items-center")}>
        <NavRow
          collapsed={collapsed}
          icon={<Settings />}
          label={<Trans>Settings</Trans>}
          tip={t`Settings`}
          onClick={onOpenSettings}
        />
        {personName ? (
          <div
            className={cn(
              "flex items-center gap-3 py-2 text-[15.5px] text-sidebar-foreground",
              collapsed ? "justify-center" : "px-3.5",
            )}
            title={collapsed ? personName : undefined}
          >
            <span
              aria-hidden="true"
              className="grid size-8 shrink-0 place-items-center rounded-full bg-foreground text-[13px] font-semibold text-background"
            >
              {personName.trim().charAt(0).toUpperCase()}
            </span>
            {collapsed ? null : (
              <span className="truncate" dir="auto">
                {personName}
              </span>
            )}
          </div>
        ) : null}
      </div>
    </nav>
  );
}

function sidebarStatus(
  tone: "neutral" | "live" | "attention",
  askCount: number,
  t: ReturnType<typeof useLingui>["t"],
): string {
  if (tone === "attention") {
    return askCount === 1 ? t`1 thing needs you` : t`${askCount} things need you`;
  }
  if (tone === "live") return t`Working on it`;
  return t`Ready when you are`;
}

function RailTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      {children}
      <TooltipContent side="right" sideOffset={10} className="text-[13px]">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

// The icon pops with a little springy tilt on hover and presses in on click.
const ICON_MOTION =
  "transition-transform duration-300 ease-[cubic-bezier(.34,1.56,.64,1)] group-hover:-translate-y-0.5 group-hover:scale-[1.15] group-hover:-rotate-6 group-active:scale-95 motion-reduce:transition-none motion-reduce:transform-none";

function NavRow({
  icon,
  label,
  tip,
  meta,
  active = false,
  attention = false,
  collapsed = false,
  onClick,
}: {
  icon: ReactNode;
  label: ReactNode;
  tip?: string;
  meta?: string;
  active?: boolean;
  attention?: boolean;
  collapsed?: boolean;
  onClick: () => void;
}) {
  if (collapsed) {
    return (
      <RailTip label={tip ?? ""}>
        <TooltipTrigger
          onClick={onClick}
          aria-label={tip}
          aria-current={active ? "page" : undefined}
          className={cn(
            "group relative grid size-11 place-items-center rounded-xl transition-colors [&_svg]:size-5 [&_svg]:stroke-[1.75]",
            "focus-visible:outline-2 focus-visible:outline-ring",
            active
              ? "bg-sidebar-accent text-foreground"
              : "text-muted-foreground hover:bg-sidebar-accent/70 hover:text-foreground",
          )}
        >
          <span className={ICON_MOTION}>{icon}</span>
          {meta ? (
            <span
              className={cn(
                "absolute -top-0.5 -end-0.5 grid h-4 min-w-4 place-items-center rounded-full px-1 text-[10px] font-semibold tabular-nums",
                attention ? "bg-warning text-background" : "bg-foreground text-background",
              )}
            >
              {meta}
            </span>
          ) : null}
        </TooltipTrigger>
      </RailTip>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group flex h-11 items-center gap-3.5 rounded-xl px-3.5 text-start text-[16px] transition-colors [&_svg]:size-5 [&_svg]:shrink-0 [&_svg]:stroke-[1.75]",
        "focus-visible:outline-2 focus-visible:outline-ring",
        active
          ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
          : "text-sidebar-foreground/80 hover:bg-sidebar-accent/70 hover:text-sidebar-foreground",
      )}
    >
      <span
        className={cn(
          ICON_MOTION,
          active ? "text-foreground" : "text-muted-foreground group-hover:text-foreground",
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate transition-transform duration-200 group-hover:translate-x-0.5">
        {label}
      </span>
      {meta ? (
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 text-[12.5px] font-medium tabular-nums",
            attention ? "bg-warning/15 text-warning" : "text-muted-foreground",
          )}
        >
          {meta}
        </span>
      ) : null}
    </button>
  );
}
