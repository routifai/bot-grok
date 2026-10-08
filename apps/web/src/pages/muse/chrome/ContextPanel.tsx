import type { Ask, Goal } from "@aiden/contracts";
import { DEFAULT_MUSE_COLOR } from "@aiden/contracts";
import { nextCronDateAcross } from "@aiden/core";
import { BotAvatar, cn, Tooltip, TooltipContent, TooltipTrigger } from "@aiden/ui-web";
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { LucideIcon } from "lucide-react";
import {
  Bell,
  BookmarkPlus,
  Clock,
  Fingerprint,
  HelpCircle,
  List,
  ScrollText,
  ShieldCheck,
  Sparkles,
  Target,
} from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { MuseRailView } from "../../../components/AppRail";
import { formatRelativeTime } from "../../../lib/relative-time";
import { rpc } from "../../../lib/rpc";
import { useAsks } from "../asks";
import {
  dueMeta,
  type GoalDisplayStatus,
  goalDisplayStatus,
  nextUnfinishedTask,
  taskCounts,
} from "../goals/format";
import { StatusPill, Surface } from "../ui";
import { ActivityPanel } from "./ActivityPanel";
import type { ActivityWire } from "./ActivityRunDialog";
import {
  type ConnectionLatch,
  INITIAL_CONNECTION_LATCH,
  nextConnectionLatch,
} from "./connectionStatus";
import { MemoryTab, type MemoryWire } from "./MemoryTab";
import { type ActivitiesState, LIVE_ACTIVITY_WIRE, useActivities } from "./useActivities";
import type { ChatListState } from "./useChatList";

// The right-hand context panel beside the Conversation (docs/muse/DESIGN.md, "Conversation"):
// only what matters right now, pulled from data the shell already loads elsewhere (Asks,
// Goals). It never fetches anything the Feed/Goals screens don't already show.
const ASKS_LIMIT = 3;
const GOALS_LIMIT = 3;
const CHECKINS_LIMIT = 4;
const GOALS_POLL_MS = 30_000;
const STORAGE_KEY = "muse:context-panel-collapsed";

const ASK_ICON = {
  approval: ShieldCheck,
  proposal: Sparkles,
  question: HelpCircle,
  blocked_task: HelpCircle,
  skill_offer: BookmarkPlus,
} as const;

const IN_PROGRESS_TONE: Record<GoalDisplayStatus, "attention" | "live" | "neutral"> = {
  waiting: "attention",
  working: "live",
  paused: "neutral",
  noPlan: "neutral",
  onTrack: "neutral",
};

function inProgressLabel(status: GoalDisplayStatus): string {
  if (status === "waiting") return t`Waiting on you`;
  if (status === "working") return t`Working`;
  if (status === "paused") return t`Paused`;
  if (status === "noPlan") return t`No plan yet`;
  return t`On track`;
}

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

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function reducedMotionSnapshot(): boolean {
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

function subscribeToReducedMotion(onChange: () => void): () => void {
  const media = window.matchMedia(REDUCED_MOTION_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/** Whether the person asked for less motion, so the progress ring can skip its draw-in. */
function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeToReducedMotion, reducedMotionSnapshot, () => false);
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
  return rows.sort((a, b) => a.next.getTime() - b.next.getTime()).slice(0, CHECKINS_LIMIT);
}

/** A date's calendar day and clock time in a given timezone, for comparing "today"/"tomorrow". */
function checkInDateParts(
  date: Date,
  timezone: string,
): { dateKey: string; hour: number; minute: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    dateKey: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")),
    minute: get("minute"),
  };
}

/**
 * A check-in's time chip in the Goal's own timezone ("Today 7:30", "Tomorrow 9:00",
 * "Sun 9:00"), plus whether it falls today (emphasized on the "Coming up" timeline).
 */
function formatCheckInChip(
  date: Date,
  timezone: string,
  locale: string,
  now: Date,
): { label: string; isToday: boolean } {
  const target = checkInDateParts(date, timezone);
  const today = checkInDateParts(now, timezone);
  const tomorrow = checkInDateParts(new Date(now.getTime() + 24 * 60 * 60 * 1000), timezone);
  const time = `${target.hour}:${target.minute}`;
  if (target.dateKey === today.dateKey) return { label: t`Today ${time}`, isToday: true };
  if (target.dateKey === tomorrow.dateKey) return { label: t`Tomorrow ${time}`, isToday: false };
  const weekday = new Intl.DateTimeFormat(locale || "en", {
    timeZone: timezone,
    weekday: "short",
  }).format(date);
  return { label: `${weekday} ${time}`, isToday: false };
}

/** A section's calm header: a small icon, a plain title, and a muted count. */
function PanelSectionHeader({
  icon: Icon,
  title,
  count,
}: {
  icon: LucideIcon;
  title: string;
  count: number;
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon
        size={16}
        strokeWidth={1.75}
        aria-hidden="true"
        className="shrink-0 text-muted-foreground"
      />
      <h3 className="text-[13.5px] font-semibold text-foreground">{title}</h3>
      <span className="ms-auto font-mono text-[12px] tabular-nums text-ink-3">{count}</span>
    </div>
  );
}

const RING_SIZE = 36;
const RING_STROKE = 3;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** A Goal's Task progress as a small ring (docs/muse/DESIGN.md "Goals"), drawing in from 0
 * on mount unless the person prefers less motion, in which case it renders at rest. */
function GoalRing({ done, total }: { done: number; total: number }) {
  const reducedMotion = usePrefersReducedMotion();
  const fraction = total > 0 ? Math.max(0, Math.min(1, done / total)) : 0;
  const [drawn, setDrawn] = useState(reducedMotion ? fraction : 0);

  useEffect(() => {
    if (reducedMotion) {
      setDrawn(fraction);
      return;
    }
    setDrawn(0);
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setDrawn(fraction));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [fraction, reducedMotion]);

  const offset = RING_CIRCUMFERENCE * (1 - drawn);

  return (
    <span
      role="img"
      aria-label={t`${done} of ${total} Tasks done`}
      className="relative flex size-9 shrink-0 items-center justify-center"
    >
      <svg
        width={RING_SIZE}
        height={RING_SIZE}
        viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
        aria-hidden="true"
        className="-rotate-90"
      >
        <circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RING_RADIUS}
          fill="none"
          strokeWidth={RING_STROKE}
          className="stroke-muted"
        />
        <circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RING_RADIUS}
          fill="none"
          strokeWidth={RING_STROKE}
          strokeLinecap="round"
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={offset}
          className={cn(
            "stroke-foreground",
            !reducedMotion && "transition-[stroke-dashoffset] duration-700 ease-out",
          )}
        />
      </svg>
      <span
        aria-hidden="true"
        className="absolute inset-0 flex items-center justify-center text-[10px] font-medium tabular-nums text-foreground"
      >
        {done}/{total}
      </span>
    </span>
  );
}

/** One in-progress Goal card: its ring, title, next Task, status, and due date. */
function InProgressGoalCard({ goal, onNavigate }: { goal: Goal; onNavigate: () => void }) {
  const { i18n } = useLingui();
  const next = nextUnfinishedTask(goal);
  const { done, total } = taskCounts(goal);
  const due = dueMeta(goal.due, i18n.locale);
  const status = goalDisplayStatus(goal);

  return (
    <Surface
      interactive
      role="button"
      tabIndex={0}
      data-testid="context-panel-goal-card"
      aria-label={goal.title}
      onClick={onNavigate}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onNavigate();
        }
      }}
      className="flex items-start gap-3 rounded-xl p-3.5 outline-none transition-[border-color,box-shadow,transform] duration-150 motion-safe:hover:-translate-y-px"
    >
      <GoalRing done={done} total={total} />
      <div className="flex min-w-0 flex-1 flex-col gap-1 pt-0.5">
        <p
          className="line-clamp-2 text-[14.5px] leading-snug font-medium text-foreground"
          dir="auto"
        >
          {goal.title}
        </p>
        {next ? (
          <p
            className="flex min-w-0 items-center gap-1 text-[13px] text-muted-foreground"
            dir="auto"
          >
            <span aria-hidden="true">→</span>
            <span className="min-w-0 truncate">{next.title}</span>
          </p>
        ) : null}
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <StatusPill tone={IN_PROGRESS_TONE[status]}>{inProgressLabel(status)}</StatusPill>
          {due ? (
            <span className="text-[12px] text-muted-foreground">
              {due.kind === "absolute" ? t`Due ${due.date}` : t`in ${due.weeks} weeks`}
            </span>
          ) : null}
        </div>
      </div>
    </Surface>
  );
}

const CHECKIN_NODE = "relative z-[1] flex size-5 shrink-0 items-center justify-center";

/** One row of the "Coming up" timeline: a dot, a time chip, a bell, the Goal's title. */
function CheckInRow({
  goal,
  next,
  locale,
  now,
  onNavigate,
}: {
  goal: Goal;
  next: Date;
  locale: string;
  now: Date;
  onNavigate: () => void;
}) {
  const chip = formatCheckInChip(next, goal.timezone, locale, now);
  return (
    <li className="relative">
      <button
        type="button"
        onClick={onNavigate}
        data-testid="context-panel-checkin-row"
        className="flex w-full items-center gap-2 rounded-lg py-1 pe-1 text-start transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
      >
        <span className={CHECKIN_NODE}>
          <span
            aria-hidden="true"
            className={cn(
              "size-[7px] rounded-full ring-4 ring-background",
              chip.isToday ? "bg-foreground" : "bg-muted-foreground/50",
            )}
          />
        </span>
        <span
          className={cn(
            "shrink-0 rounded-full border px-2 py-0.5 text-[11.5px] tabular-nums",
            chip.isToday
              ? "border-foreground/25 bg-foreground/[0.06] font-semibold text-foreground"
              : "border-border text-muted-foreground",
          )}
        >
          {chip.label}
        </span>
        <Bell
          size={12}
          strokeWidth={1.75}
          aria-hidden="true"
          className="shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 flex-1 truncate text-[13.5px] text-foreground" dir="auto">
          {goal.title}
        </span>
      </button>
    </li>
  );
}

/** One compact "Waiting on you" row: a kind icon, the Ask's title, and a relative time. */
function WaitingRow({ ask, onOpenWaiting }: { ask: Ask; onOpenWaiting: () => void }) {
  const Icon = ASK_ICON[ask.kind];
  const title = ask.kind === "approval" ? t`One yes before I send this` : ask.text;
  return (
    <button
      type="button"
      onClick={onOpenWaiting}
      data-testid="context-panel-ask-row"
      className="flex items-center gap-2.5 rounded-lg py-1.5 pe-1 text-start transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
    >
      <span
        aria-hidden="true"
        className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted"
      >
        <Icon size={13} strokeWidth={1.75} className="text-muted-foreground" />
      </span>
      <span className="min-w-0 flex-1 truncate text-[14px] text-foreground" dir="auto">
        {title}
      </span>
      <span className="shrink-0 text-[12px] text-muted-foreground">
        {formatRelativeTime(ask.createdAt)}
      </span>
    </button>
  );
}

type PanelTab = "activity" | "memory" | "context";

const PANEL_TABS: { id: PanelTab; icon: LucideIcon; label: () => string }[] = [
  { id: "activity", icon: List, label: () => t`Activity` },
  { id: "memory", icon: Fingerprint, label: () => t`Memory` },
  // Asks, in-progress Goals, and upcoming Check-ins — already working, so it keeps a tab
  // here rather than losing its spot. A permissions tab (shield icon) and a scheduled-work
  // tab (clock icon) belong here too, once there's something real behind them.
  { id: "context", icon: ScrollText, label: () => t`Context` },
];

/** The segmented icon tab bar: one rounded pill track, the selected segment raised on a
 * plain chip, a thin divider only between two segments that are both unselected. */
function PanelTabBar({ tab, onChange }: { tab: PanelTab; onChange: (tab: PanelTab) => void }) {
  return (
    <div
      role="tablist"
      aria-label={t`Panel sections`}
      className="inline-flex items-center gap-0.5 self-center rounded-full bg-selection p-[3px]"
    >
      {PANEL_TABS.map((item, index) => {
        const previous = PANEL_TABS[index - 1];
        const showDivider = index > 0 && previous && previous.id !== tab && item.id !== tab;
        const label = item.label();
        const Icon = item.icon;
        return (
          <Fragment key={item.id}>
            {showDivider ? <span aria-hidden="true" className="h-4 w-px shrink-0 bg-line" /> : null}
            <Tooltip>
              <TooltipTrigger
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                aria-label={label}
                data-testid={`context-panel-tab-${item.id}`}
                onClick={() => onChange(item.id)}
                className={cn(
                  "flex size-8 items-center justify-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                  tab === item.id
                    ? "bg-solid text-foreground shadow-xs"
                    : "text-ink-2 hover:text-foreground",
                )}
              >
                <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-[12.5px]">
                {label}
              </TooltipContent>
            </Tooltip>
          </Fragment>
        );
      })}
    </div>
  );
}

/** The panel's one Agent Identity header (docs/muse/DESIGN.md "The Muse"): the Muse's own
 * face, its name, and a Connection Status line (the sidebar no longer repeats it,
 * MuseSidebar.tsx). This panel is hidden below `xl`, when the person collapses it, or
 * while a side panel (computer/settings) is open, so it isn't always the one place —
 * `ConversationHeader.tsx`'s compact identity covers exactly those cases, so the Muse's
 * identity still shows once, whichever of the two is visible. */
function IdentityHeader({
  botId,
  museName,
  avatarColor,
  connection,
}: {
  botId: string;
  museName: string;
  avatarColor: string;
  connection: "connected" | "connecting";
}) {
  const { t: tt } = useLingui();
  return (
    <div className="flex flex-col items-center gap-2 pt-1 text-center">
      <BotAvatar color={avatarColor} identity={botId} face="muse" size={56} />
      <span
        data-testid="context-panel-muse-name"
        className="text-[15px] font-semibold text-foreground"
        dir="auto"
      >
        {museName}
      </span>
      <span
        data-testid="context-panel-connection"
        className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground"
      >
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 rounded-full",
            connection === "connected"
              ? "bg-success"
              : "animate-pulse bg-muted-foreground/50 motion-reduce:animate-none",
          )}
        />
        {connection === "connected" ? tt`Connected` : tt`Connecting…`}
      </span>
    </div>
  );
}

/**
 * The Conversation's right-hand context panel (docs/muse/DESIGN.md): the Muse's identity,
 * then its Activity, Memory, and (what's waiting / in progress / coming up) in a segmented
 * tab bar — nothing that isn't already shown elsewhere, just surfaced beside the chat
 * instead of a click away. Hidden below 1280px (the caller controls that with CSS;
 * `collapsed` is the person's own choice).
 */
export function ContextPanel({
  botId,
  museName,
  avatarColor = DEFAULT_MUSE_COLOR,
  collapsed,
  chatListState,
  activitiesOverride,
  memoryWire,
  onNavigate,
  onOpenWaiting,
}: {
  botId: string;
  /** The Muse's own name, for the panel's identity header. */
  museName: string;
  /** The Muse's own color, for its face in the header and the empty state. */
  avatarColor?: string;
  collapsed: boolean;
  /** The sidebar's Chat List poll (Shell.tsx's `chatList.state`), folded into the
   * Connection Status line alongside the Activity poll — either one landing counts. */
  chatListState?: ChatListState;
  /** Dev-preview seam only (ActivityPreviewPage.tsx): fixture Activity data + wire instead
   * of the real poll. Production never passes this. */
  activitiesOverride?: {
    state: ActivitiesState;
    wire: ActivityWire;
    loadEarlier: () => Promise<void>;
    loadingEarlier: boolean;
  };
  /** Dev-preview seam only: a fixture Memory wire instead of `rpc.memory.profile`. */
  memoryWire?: MemoryWire;
  onNavigate: (view: MuseRailView) => void;
  onOpenWaiting: () => void;
}) {
  const { t: tt, i18n } = useLingui();
  const [tab, setTab] = useState<PanelTab>("activity");
  const { asks } = useAsks(botId);
  const [goals, setGoals] = useState<Goal[]>([]);
  const generation = useRef(0);
  const liveActivities = useActivities(botId);
  const liveMemoryWire = useMemo<MemoryWire>(
    () => ({
      profile: (input) => rpc.memory.profile(input),
      claims: (input) => rpc.memory.claims(input),
      editClaim: (input) => rpc.memory.editClaim(input),
      forgetClaim: (input) => rpc.memory.forgetClaim(input),
      dailyNotes: (input) => rpc.memory.dailyNotes(input),
      saveDailyNote: (input) => rpc.memory.saveDailyNote(input),
    }),
    [],
  );
  const activitiesData = activitiesOverride ?? {
    state: liveActivities.state,
    wire: LIVE_ACTIVITY_WIRE,
    loadEarlier: liveActivities.loadEarlier,
    loadingEarlier: liveActivities.loadingEarlier,
  };
  const memoryWireToUse = memoryWire ?? liveMemoryWire;
  const [connectionLatch, setConnectionLatch] = useState<ConnectionLatch>(INITIAL_CONNECTION_LATCH);
  // `activitiesData.state`/`chatListState` change identity on every poll round (success or
  // failure alike, useActivities.ts / useChatList.ts) — exactly the "once per observed
  // round" cadence the latch wants (connectionStatus.ts's `nextConnectionLatch`).
  useEffect(() => {
    setConnectionLatch((prev) => nextConnectionLatch(prev, activitiesData.state, chatListState));
  }, [activitiesData.state, chatListState]);
  const connection = connectionLatch.status;

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

  const topAsks = asks.slice(0, ASKS_LIMIT);
  const activeGoals = useMemo(() => goals.filter((goal) => goal.status === "active"), [goals]);
  const inProgress = useMemo(() => {
    return [...activeGoals]
      .sort((a, b) => {
        const aTime = Date.parse(a.lastWorkedAt ?? a.updatedAt);
        const bTime = Date.parse(b.lastWorkedAt ?? b.updatedAt);
        return bTime - aTime;
      })
      .slice(0, GOALS_LIMIT);
  }, [activeGoals]);
  const now = useMemo(() => new Date(), [goals]);
  const checkIns = useMemo(() => upcomingCheckIns(goals, now), [goals, now]);

  const contextEmpty = topAsks.length === 0 && inProgress.length === 0 && checkIns.length === 0;

  return (
    <div
      data-testid="context-panel"
      className={cn(
        "hidden w-[340px] shrink-0 flex-col gap-4 border border-line bg-panel backdrop-blur-xl md:rounded-[18px]",
        !collapsed && "xl:flex",
      )}
    >
      <div className="flex shrink-0 flex-col gap-4 px-5 pt-5">
        <IdentityHeader
          botId={botId}
          museName={museName}
          avatarColor={avatarColor}
          connection={connection}
        />
        <PanelTabBar tab={tab} onChange={setTab} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto rk-scroll px-5 pb-5">
        {tab === "activity" ? (
          <ActivityPanel
            botId={botId}
            wire={activitiesData.wire}
            state={activitiesData.state}
            loadEarlier={activitiesData.loadEarlier}
            loadingEarlier={activitiesData.loadingEarlier}
          />
        ) : tab === "memory" ? (
          <MemoryTab botId={botId} wire={memoryWireToUse} />
        ) : contextEmpty ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 py-10 text-center">
            <BotAvatar color={avatarColor} identity={botId} face="muse" size={40} />
            <p className="text-[14.5px] text-muted-foreground">{tt`You're all caught up.`}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-7">
            {topAsks.length > 0 ? (
              <section className="flex flex-col gap-2" data-testid="context-panel-asks">
                <PanelSectionHeader icon={Bell} title={tt`Waiting on you`} count={asks.length} />
                <div className="flex flex-col gap-0.5">
                  {topAsks.map((ask) => (
                    <WaitingRow key={ask.id} ask={ask} onOpenWaiting={onOpenWaiting} />
                  ))}
                </div>
                {asks.length > ASKS_LIMIT ? (
                  <button
                    type="button"
                    onClick={onOpenWaiting}
                    data-testid="context-panel-view-all"
                    className="self-start rounded-md text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    {tt`View all`}
                  </button>
                ) : null}
              </section>
            ) : null}

            {inProgress.length > 0 ? (
              <section className="flex flex-col gap-2.5" data-testid="context-panel-goals">
                <PanelSectionHeader
                  icon={Target}
                  title={tt`In progress`}
                  count={activeGoals.length}
                />
                <div className="flex flex-col gap-2.5">
                  {inProgress.map((goal) => (
                    <InProgressGoalCard
                      key={goal.id}
                      goal={goal}
                      onNavigate={() => onNavigate("goals")}
                    />
                  ))}
                </div>
              </section>
            ) : null}

            {checkIns.length > 0 ? (
              <section className="flex flex-col gap-2" data-testid="context-panel-checkins">
                <PanelSectionHeader icon={Clock} title={tt`Coming up`} count={checkIns.length} />
                <ol className="relative flex flex-col">
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-y-2.5 start-2.5 w-px bg-border"
                  />
                  {checkIns.map(({ goal, next }) => (
                    <CheckInRow
                      key={goal.id}
                      goal={goal}
                      next={next}
                      locale={i18n.locale}
                      now={now}
                      onNavigate={() => onNavigate("goals")}
                    />
                  ))}
                </ol>
              </section>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
