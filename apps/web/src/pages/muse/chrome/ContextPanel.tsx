import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { Ask, Goal } from "@rakazo/contracts";
import { nextCronDateAcross } from "@rakazo/core";
import { cn } from "@rakazo/ui-web";
import { HelpCircle, ShieldCheck, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MuseRailView } from "../../../components/AppRail";
import { rpc } from "../../../lib/rpc";
import { useAsks } from "../asks";
import { nextUnfinishedTask, taskCounts } from "../goals/format";
import { Eyebrow, Progress } from "../ui";

// The right-hand context panel beside the Conversation (docs/muse/DESIGN.md, "Conversation"):
// only what matters right now, pulled from data the shell already loads elsewhere (Asks,
// Goals). It never fetches anything the Feed/Goals screens don't already show.
const LIST_LIMIT = 3;
const GOALS_POLL_MS = 30_000;
const STORAGE_KEY = "muse:context-panel-collapsed";

const ASK_ICON = {
  approval: ShieldCheck,
  proposal: Sparkles,
  question: HelpCircle,
  blocked_task: HelpCircle,
} as const;

/**
 * Whether the person collapsed the context panel, persisted across sessions. Read once at
 * mount and written on every toggle; a missing or unreadable value defaults to open.
 */
export function useContextPanelCollapsed(): [boolean, (next: boolean) => void] {
  const [collapsed, setCollapsedState] = useState(() => {
    try {
      return window.localStorage.getItem(STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const setCollapsed = useCallback((next: boolean) => {
    setCollapsedState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
    } catch {
      // Best-effort; the toggle still works for the rest of this session.
    }
  }, []);
  return [collapsed, setCollapsed];
}

/** The nearest upcoming check-in per active Goal that has one, soonest first. */
function upcomingCheckIns(goals: Goal[], now: Date): { goal: Goal; next: Date }[] {
  const rows: { goal: Goal; next: Date }[] = [];
  for (const goal of goals) {
    if (goal.status !== "active" || goal.checkInCrons.length === 0) continue;
    let next: Date | null;
    try {
      next = nextCronDateAcross(goal.checkInCrons, now, goal.timezone);
    } catch {
      next = null;
    }
    if (next) rows.push({ goal, next });
  }
  return rows.sort((a, b) => a.next.getTime() - b.next.getTime()).slice(0, LIST_LIMIT);
}

/** A compact, forward-looking time for a check-in row ("in 5m", "in 2d", "Tue 9:00 AM"). */
function formatCheckInEta(date: Date, locale: string, now: Date): string {
  const ms = date.getTime() - now.getTime();
  if (ms <= 0) return t`Now`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return t`in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t`in ${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return t`in ${days}d`;
  return date.toLocaleDateString(locale || "en", { weekday: "short" });
}

function PanelRow({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full flex-col gap-1 rounded-lg px-2 py-1.5 text-start transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
    >
      {children}
    </button>
  );
}

/**
 * The Conversation's right-hand context panel (docs/muse/DESIGN.md): what's waiting on the
 * person, what the Muse is actively working on, and what's coming up — nothing that isn't
 * already shown elsewhere, just surfaced beside the chat instead of a click away. Hidden
 * below 1280px (the caller controls that with CSS; `collapsed` is the person's own choice).
 */
export function ContextPanel({
  botId,
  collapsed,
  onNavigate,
  onOpenWaiting,
}: {
  botId: string;
  collapsed: boolean;
  onNavigate: (view: MuseRailView) => void;
  onOpenWaiting: () => void;
}) {
  const { i18n } = useLingui();
  const { asks } = useAsks(botId);
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
    const timer = window.setInterval(load, GOALS_POLL_MS);
    return () => {
      generation.current += 1;
      window.clearInterval(timer);
    };
  }, [botId]);

  const topAsks = asks.slice(0, LIST_LIMIT);
  const inProgress = useMemo(() => {
    return goals
      .filter((goal) => goal.status === "active")
      .sort((a, b) => {
        const aTime = Date.parse(a.lastWorkedAt ?? a.updatedAt);
        const bTime = Date.parse(b.lastWorkedAt ?? b.updatedAt);
        return bTime - aTime;
      })
      .slice(0, LIST_LIMIT);
  }, [goals]);
  const checkIns = useMemo(() => upcomingCheckIns(goals, new Date()), [goals]);

  const empty = topAsks.length === 0 && inProgress.length === 0 && checkIns.length === 0;

  return (
    <div
      data-testid="context-panel"
      className={cn(
        "hidden w-[300px] shrink-0 flex-col gap-8 overflow-y-auto rk-scroll border-s border-border px-5 py-6",
        !collapsed && "xl:flex",
      )}
    >
      {empty ? (
        <p className="text-[13px] text-muted-foreground">{t`You're all caught up.`}</p>
      ) : (
        <>
          {topAsks.length > 0 ? (
            <section className="flex flex-col gap-2" data-testid="context-panel-asks">
              <Eyebrow>{t`Waiting on you`}</Eyebrow>
              <div className="flex flex-col gap-0.5">
                {topAsks.map((ask: Ask) => {
                  const Icon = ASK_ICON[ask.kind];
                  const title = ask.kind === "approval" ? t`One yes before I send this` : ask.text;
                  return (
                    <PanelRow key={ask.id} onClick={onOpenWaiting}>
                      <span className="flex items-start gap-2">
                        <Icon
                          size={13}
                          strokeWidth={1.75}
                          aria-hidden="true"
                          className="mt-0.5 shrink-0 text-warning"
                        />
                        <span
                          className="min-w-0 flex-1 truncate text-[13px] text-foreground"
                          dir="auto"
                        >
                          {title}
                        </span>
                      </span>
                    </PanelRow>
                  );
                })}
              </div>
            </section>
          ) : null}

          {inProgress.length > 0 ? (
            <section className="flex flex-col gap-2" data-testid="context-panel-goals">
              <Eyebrow>{t`In progress`}</Eyebrow>
              <div className="flex flex-col gap-1">
                {inProgress.map((goal) => {
                  const next = nextUnfinishedTask(goal);
                  const { done, total } = taskCounts(goal);
                  return (
                    <PanelRow key={goal.id} onClick={() => onNavigate("goals")}>
                      <span className="truncate text-[13px] font-medium text-foreground" dir="auto">
                        {goal.title}
                      </span>
                      {next ? (
                        <span className="truncate text-[12px] text-muted-foreground" dir="auto">
                          {next.title}
                        </span>
                      ) : null}
                      {total > 0 ? (
                        <Progress value={done / total} label={t`${done} of ${total} Tasks done`} />
                      ) : null}
                    </PanelRow>
                  );
                })}
              </div>
            </section>
          ) : null}

          {checkIns.length > 0 ? (
            <section className="flex flex-col gap-2" data-testid="context-panel-checkins">
              <Eyebrow>{t`Coming up`}</Eyebrow>
              <div className="flex flex-col gap-0.5">
                {checkIns.map(({ goal, next }) => (
                  <PanelRow key={goal.id} onClick={() => onNavigate("goals")}>
                    <span className="flex items-center justify-between gap-2">
                      <span
                        className="min-w-0 flex-1 truncate text-[13px] text-foreground"
                        dir="auto"
                      >
                        {goal.title}
                      </span>
                      <span className="shrink-0 text-[12px] text-muted-foreground">
                        {formatCheckInEta(next, i18n.locale, new Date())}
                      </span>
                    </span>
                  </PanelRow>
                ))}
              </div>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
