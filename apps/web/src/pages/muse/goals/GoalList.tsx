import { Trans, useLingui } from "@lingui/react/macro";
import type { Goal } from "@rakazo/contracts";
import { Skeleton } from "@rakazo/ui-web";
import { EmptyState, MuseWideColumn, Progress, ScreenHeader, Section, Surface } from "../ui";
import { dueMeta, goalsSummary, nextUnfinishedTask, taskCounts } from "./format";
import { GoalStatusPill } from "./GoalStatusPill";

function GoalCard({ goal, onSelect }: { goal: Goal; onSelect: (goalId: string) => void }) {
  const { t, i18n } = useLingui();
  const next = nextUnfinishedTask(goal);
  const { done, total } = taskCounts(goal);
  const due = dueMeta(goal.due, i18n.locale);

  return (
    <Surface
      interactive
      role="button"
      tabIndex={0}
      data-testid="goal-row"
      aria-label={goal.title}
      onClick={() => onSelect(goal.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(goal.id);
        }
      }}
      className="flex flex-col gap-2.5 p-4 outline-none"
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="min-w-0 truncate text-[14.5px] font-semibold text-foreground" dir="auto">
          {goal.title}
        </h3>
        <GoalStatusPill goal={goal} className="shrink-0" />
      </div>
      {next ? (
        <p className="truncate text-[13.5px] text-muted-foreground" dir="auto">
          <Trans>Next: {next.title}</Trans>
        </p>
      ) : null}
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <Progress
            value={total > 0 ? done / total : 0}
            label={t`${done} of ${total} Tasks done`}
          />
        </div>
        <span className="shrink-0 text-[12px] text-muted-foreground">{t`${done} of ${total}`}</span>
      </div>
      {due ? (
        <p className="text-[12.5px] text-muted-foreground">
          {due.kind === "absolute" ? (
            <Trans>Due {due.date}</Trans>
          ) : (
            <Trans>in {due.weeks} weeks</Trans>
          )}
        </p>
      ) : null}
    </Surface>
  );
}

/** Loading placeholder for the Goals list: a few skeleton cards under the real header. */
export function GoalListSkeleton() {
  return (
    <MuseWideColumn>
      <ScreenHeader title={<Trans>Goals</Trans>} />
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {[0, 1, 2].map((key) => (
          <Surface key={key} className="flex flex-col gap-3 p-4">
            <div className="flex items-center justify-between gap-3">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-5 w-24 rounded-full" />
            </div>
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="h-1 w-full rounded-full" />
            <Skeleton className="h-3 w-1/5" />
          </Surface>
        ))}
      </div>
    </MuseWideColumn>
  );
}

export function GoalList({
  goals,
  onSelect,
}: {
  goals: Goal[];
  onSelect: (goalId: string) => void;
}) {
  const { t } = useLingui();

  if (goals.length === 0) {
    return (
      <MuseWideColumn>
        <ScreenHeader title={<Trans>Goals</Trans>} />
        <EmptyState lead={t`What do you want to achieve?`}>
          <Trans>Tell your Muse, and it becomes a Goal.</Trans>
        </EmptyState>
      </MuseWideColumn>
    );
  }

  const active = goals.filter((goal) => goal.status !== "paused");
  const paused = goals.filter((goal) => goal.status === "paused");
  const { active: activeCount, waiting } = goalsSummary(goals);
  const subtitle =
    waiting > 0 ? t`${activeCount} active · ${waiting} waiting on you` : t`${activeCount} active`;

  return (
    <MuseWideColumn data-testid="goals-list">
      <ScreenHeader title={<Trans>Goals</Trans>} subtitle={subtitle} />
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {active.map((goal) => (
          <GoalCard key={goal.id} goal={goal} onSelect={onSelect} />
        ))}
      </div>
      {paused.length > 0 ? (
        <Section title={<Trans>Paused</Trans>} className="mt-10">
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {paused.map((goal) => (
              <GoalCard key={goal.id} goal={goal} onSelect={onSelect} />
            ))}
          </div>
        </Section>
      ) : null}
    </MuseWideColumn>
  );
}
