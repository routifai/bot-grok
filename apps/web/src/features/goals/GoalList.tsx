import { Trans, useLingui } from "@lingui/react/macro";
import type { Goal } from "@nova/contracts";
import { cn, Skeleton } from "@nova/ui-web";
import { useState } from "react";
import { rpc } from "../../../lib/rpc";
import { GoalsGlyph, SparkGlyph } from "../chrome/NovaGlyphs";
import { NovaTile } from "../chrome/NovaTile";
import {
  ACCENT_BUTTON,
  MuseWideCenter,
  PRIMARY_BUTTON,
  QUIET_BUTTON,
  ScreenHero,
  Section,
} from "../ui";
import {
  dueMeta,
  type GoalDisplayStatus,
  goalDisplayStatus,
  goalsSummary,
  nextUnfinishedTask,
  taskCounts,
} from "./format";
import { type GoalStarter, GoalsIntro } from "./GoalsIntro";
import { GoalRing } from "./visuals";

/** A ring color per card: waiting is orange, paused gray, the rest cycle green, blue, purple. */
const RING_TONES = ["stroke-sig-goals", "stroke-tint", "stroke-sig-forks"] as const;

function ringTone(status: GoalDisplayStatus, index: number): string {
  if (status === "waiting") return "stroke-sig-waiting";
  if (status === "paused") return "stroke-ink-3";
  return RING_TONES[index % RING_TONES.length] ?? "stroke-sig-goals";
}

/** One Goal as a card (docs/muse/DESIGN.md "Goals"): a progress ring with "3 of 5", the title,
 * the next Task, and a quiet meta line (status, due date). */
function GoalCard({
  goal,
  index,
  onSelect,
}: {
  goal: Goal;
  index: number;
  onSelect: (goalId: string) => void;
}) {
  const { t, i18n } = useLingui();
  const { done, total } = taskCounts(goal);
  const due = dueMeta(goal.due, i18n.locale);
  const status = goalDisplayStatus(goal);
  const next = nextUnfinishedTask(goal);
  const firstPlan = goal.tasks.length === 0 && goal.openProposal;
  const statusLabel =
    status === "waiting"
      ? firstPlan
        ? t`Plan to review`
        : t`Needs you`
      : status === "paused"
        ? t`Paused`
        : status === "working"
          ? t`Working`
          : status === "noPlan"
            ? t`No plan yet`
            : null;
  const meta = [
    statusLabel,
    due ? (due.kind === "absolute" ? t`Due ${due.date}` : t`in ${due.weeks} weeks`) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <button
      type="button"
      data-testid="goal-row"
      aria-label={goal.title}
      onClick={() => onSelect(goal.id)}
      className="nova-card flex min-w-0 flex-col gap-2.5 p-4 text-start transition-colors hover:bg-selection focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <span className="flex items-center gap-3">
        <GoalRing
          value={total > 0 ? done / total : 0}
          toneClass={ringTone(status, index)}
          size="sm"
        />
        {total > 0 ? (
          <span className="text-[22px] font-semibold tabular-nums text-foreground">
            {done}
            <span className="ms-1 text-[13px] font-medium text-ink-3">{t`of ${total}`}</span>
          </span>
        ) : null}
      </span>
      <span
        className="line-clamp-2 text-[16px] leading-[1.25] font-semibold tracking-[-0.1px] text-foreground"
        dir="auto"
      >
        {goal.title}
      </span>
      {next ? (
        <span className="line-clamp-2 text-[13px] text-ink-2" dir="auto">
          {t`Next:`} <span className="font-medium text-foreground">{next.title}</span>
        </span>
      ) : null}
      {meta ? (
        <span
          className={cn(
            "text-[12.5px]",
            status === "waiting" ? "font-medium text-sig-waiting" : "text-ink-3",
          )}
        >
          {meta}
        </span>
      ) : null}
    </button>
  );
}

/** A Goal's open plan as a decision card at the top of the list: Start it, or not now. */
function ProposalDecision({ goal, onChanged }: { goal: Goal; onChanged: (goal: Goal) => void }) {
  const { t } = useLingui();
  const [pending, setPending] = useState<"accept" | "dismiss" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const proposal = goal.openProposal;
  if (!proposal) return null;
  const first = goal.tasks.length === 0;
  const firstStep = proposal.tasks[0]?.title;

  async function run(action: "accept" | "dismiss") {
    if (pending || !proposal) return;
    setPending(action);
    setError(null);
    try {
      const input = { goalId: goal.id, proposalId: proposal.id };
      onChanged(
        await (action === "accept"
          ? rpc.goals.acceptProposal(input)
          : rpc.goals.dismissProposal(input)),
      );
    } catch {
      setError(t`Could not save`);
    } finally {
      setPending(null);
    }
  }

  return (
    <div data-testid="goal-proposal-decision" className="nova-card flex flex-col gap-1.5 p-3.5">
      <div className="flex items-start gap-2.5">
        <NovaTile tone="orange" size={28}>
          <SparkGlyph />
        </NovaTile>
        <div className="min-w-0 flex-1">
          <p className="text-[14px] leading-[1.3] font-semibold text-foreground" dir="auto">
            {first ? t`A plan is ready for “${goal.title}”` : t`A new plan for “${goal.title}”`}
          </p>
          {firstStep ? (
            <p className="mt-0.5 truncate text-[12px] text-ink-3" dir="auto">
              {t`First: ${firstStep}`}
            </p>
          ) : null}
        </div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={pending !== null}
          onClick={() => void run("dismiss")}
          className={QUIET_BUTTON}
        >
          {first ? t`Not now` : t`Keep current`}
        </button>
        <button
          type="button"
          disabled={pending !== null}
          onClick={() => void run("accept")}
          className={PRIMARY_BUTTON}
        >
          {pending === "accept" ? t`Starting…` : first ? t`Start this plan` : t`Use the new plan`}
        </button>
      </div>
      {error ? <p className="text-[12px] text-destructive">{error}</p> : null}
    </div>
  );
}

/** Loading placeholder for the Goals list: a few skeleton cards. */
export function GoalListSkeleton() {
  return (
    <MuseWideCenter>
      <div className="flex items-center gap-3.5 pt-1.5">
        <Skeleton className="size-11 rounded-[30%]" />
        <div className="flex-1">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="mt-2 h-3.5 w-40" />
        </div>
      </div>
      <div className={GOAL_GRID}>
        {[0, 1, 2].map((key) => (
          <div key={key} className="nova-card flex flex-col gap-3 p-4">
            <Skeleton className="size-11 rounded-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        ))}
      </div>
    </MuseWideCenter>
  );
}

const GOAL_GRID = "grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3.5";

export function GoalList({
  goals,
  botName,
  onSelect,
  onChanged,
  starters,
  onSendIdea,
}: {
  goals: Goal[];
  botName: string;
  onSelect: (goalId: string) => void;
  /** A Goal came back changed (its plan accepted or dismissed from the list). */
  onChanged?: (goal: Goal) => void;
  starters?: readonly GoalStarter[];
  onSendIdea?: (text: string) => void;
}) {
  const { t } = useLingui();

  if (goals.length === 0) {
    return <GoalsIntro botName={botName} starters={starters ?? []} onStart={onSendIdea} />;
  }

  const active = goals.filter((goal) => goal.status !== "paused");
  const paused = goals.filter((goal) => goal.status === "paused");
  const proposals = onChanged ? active.filter((goal) => goal.openProposal) : [];
  const { active: activeCount, waiting } = goalsSummary(goals);
  const subtitle =
    waiting > 0 ? t`${activeCount} active · ${waiting} need you` : t`${activeCount} active`;

  return (
    <MuseWideCenter data-testid="goals-list">
      <ScreenHero
        tile={
          <NovaTile tone="green" size={44}>
            <GoalsGlyph />
          </NovaTile>
        }
        title={<Trans>Goals</Trans>}
        subtitle={subtitle}
        action={
          onSendIdea ? (
            <button
              type="button"
              className={ACCENT_BUTTON}
              onClick={() => onSendIdea(t`Start a new goal`)}
            >
              {t`New goal`}
            </button>
          ) : undefined
        }
      />
      {proposals.map((goal) =>
        onChanged ? <ProposalDecision key={goal.id} goal={goal} onChanged={onChanged} /> : null,
      )}
      <div className={GOAL_GRID}>
        {active.map((goal, index) => (
          <GoalCard key={goal.id} goal={goal} index={index} onSelect={onSelect} />
        ))}
      </div>
      {paused.length > 0 ? (
        <Section title={<Trans>Paused</Trans>} className="mt-4">
          <div className={GOAL_GRID}>
            {paused.map((goal, index) => (
              <GoalCard key={goal.id} goal={goal} index={index} onSelect={onSelect} />
            ))}
          </div>
        </Section>
      ) : null}
    </MuseWideCenter>
  );
}
