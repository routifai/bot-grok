import { Trans, useLingui } from "@lingui/react/macro";
import type { Goal } from "@rakazo/contracts";
import { BotAvatar, cn } from "@rakazo/ui-web";
import { Bell, Library, MessageCircle, Newspaper, Settings, Target } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { MuseRailView as MuseView } from "../../../components/AppRail";
import { rpc } from "../../../lib/rpc";
import { useAsks } from "../asks";
import { deriveStatusPill } from "./statusPill";

const MAX_SIDEBAR_GOALS = 5;

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

  const pill = deriveStatusPill({ museName, goals, running, openAskCount: askCount });
  const activeGoals = goals.filter((goal) => goal.status === "active");

  return (
    <nav
      data-testid="app-rail"
      aria-label={t`Sections`}
      className="app-drag flex w-[248px] shrink-0 flex-col gap-5 px-3 pt-4 pb-3"
    >
      <button
        type="button"
        onClick={onOpenWaiting}
        aria-label={t`Waiting on you`}
        className="app-no-drag flex items-center gap-3 rounded-xl px-2 py-2 text-start transition-colors hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-ring"
      >
        <BotAvatar
          color={color}
          identity={botId}
          status={status}
          face="muse"
          waitingCount={askCount}
          size={38}
        />
        <span className="min-w-0">
          <span className="block truncate text-[14.5px] font-semibold text-foreground" dir="auto">
            {museName}
          </span>
          <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <span
              aria-hidden="true"
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                pill.tone === "attention" && "bg-warning",
                pill.tone === "live" && "animate-[rkPulse_2.4s_ease-in-out_infinite] bg-success",
                pill.tone === "neutral" && "bg-muted-foreground/50",
              )}
            />
            <span className="truncate">{sidebarStatus(pill.tone, askCount, t)}</span>
          </span>
        </span>
      </button>

      <div className="app-no-drag flex flex-col gap-0.5">
        <NavRow
          icon={<MessageCircle />}
          label={<Trans>Conversation</Trans>}
          active={active === "conversation"}
          onClick={() => onNavigate("conversation")}
        />
        <NavRow
          icon={<Target />}
          label={<Trans>Goals</Trans>}
          meta={activeGoals.length ? String(activeGoals.length) : undefined}
          active={active === "goals"}
          onClick={() => onNavigate("goals")}
        />
        <NavRow
          icon={<Newspaper />}
          label={<Trans>Feed</Trans>}
          active={active === "feed"}
          onClick={() => onNavigate("feed")}
        />
        <NavRow
          icon={<Library />}
          label={<Trans>Library</Trans>}
          active={active === "library"}
          onClick={() => onNavigate("library")}
        />
        <NavRow
          icon={<Bell />}
          label={<Trans>Waiting on you</Trans>}
          meta={askCount ? String(askCount) : undefined}
          attention={askCount > 0}
          onClick={onOpenWaiting}
        />
      </div>

      {activeGoals.length ? (
        <div className="app-no-drag flex min-h-0 flex-col gap-0.5">
          <div className="px-2.5 pb-1 text-[12px] font-medium text-muted-foreground">
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
                className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-start text-[13px] text-sidebar-foreground/85 transition-colors hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-ring"
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
                <span className="shrink-0 text-[11.5px] tabular-nums text-muted-foreground">
                  {done}/{goal.tasks.length}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="app-no-drag mt-auto flex flex-col gap-0.5">
        <NavRow icon={<Settings />} label={<Trans>Settings</Trans>} onClick={onOpenSettings} />
        {personName ? (
          <div className="flex items-center gap-2.5 px-2.5 py-2 text-[13px] text-sidebar-foreground">
            <span
              aria-hidden="true"
              className="grid size-6 shrink-0 place-items-center rounded-full bg-foreground text-[11px] font-semibold text-background"
            >
              {personName.trim().charAt(0).toUpperCase()}
            </span>
            <span className="truncate" dir="auto">
              {personName}
            </span>
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

function NavRow({
  icon,
  label,
  meta,
  active = false,
  attention = false,
  onClick,
}: {
  icon: ReactNode;
  label: ReactNode;
  meta?: string;
  active?: boolean;
  attention?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-start text-[13.5px] transition-colors [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:stroke-[1.75]",
        "focus-visible:outline-2 focus-visible:outline-ring",
        active
          ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
          : "text-sidebar-foreground/80 hover:bg-sidebar-accent/70 hover:text-sidebar-foreground",
      )}
    >
      <span className={cn(active ? "text-foreground" : "text-muted-foreground")}>{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {meta ? (
        <span
          className={cn(
            "shrink-0 rounded-full px-1.5 text-[11px] font-medium tabular-nums",
            attention ? "bg-warning/15 text-warning" : "text-muted-foreground",
          )}
        >
          {meta}
        </span>
      ) : null}
    </button>
  );
}
