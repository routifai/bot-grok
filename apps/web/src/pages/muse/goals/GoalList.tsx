import { Trans, useLingui } from "@lingui/react/macro";
import type { Goal } from "@rakazo/contracts";
import { formatDueDate, nextUnfinishedTask } from "./format";

export function GoalList({
  goals,
  onSelect,
}: {
  goals: Goal[];
  onSelect: (goalId: string) => void;
}) {
  const { t, i18n } = useLingui();

  if (goals.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-[14.5px] text-muted-foreground">
        <Trans>Tell your Muse what you'd like to achieve — it becomes a Goal.</Trans>
      </div>
    );
  }

  return (
    <div className="p-4" data-testid="goals-list">
      <h1 className="mb-3 text-[15.5px] font-medium text-foreground">
        <Trans>Goals</Trans>
      </h1>
      <div className="space-y-1">
        {goals.map((goal) => {
          const next = nextUnfinishedTask(goal);
          const due = formatDueDate(goal.due, i18n.locale);
          return (
            <button
              key={goal.id}
              type="button"
              data-testid="goal-row"
              onClick={() => onSelect(goal.id)}
              className="flex w-full flex-col gap-0.5 rounded-xl px-3 py-2.5 text-start hover:bg-accent"
            >
              <div className="flex items-center gap-2">
                <span
                  className="min-w-0 flex-1 truncate text-[14.5px] font-medium text-foreground"
                  dir="auto"
                >
                  {goal.title}
                </span>
                {goal.openProposal ? (
                  <span className="inline-flex shrink-0 items-center gap-1 text-[12px] text-muted-foreground">
                    <span aria-hidden className="size-1.5 rounded-full bg-foreground/60" />
                    <span className="sr-only">{t`Proposal waiting`}</span>
                  </span>
                ) : null}
              </div>
              <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground/80">
                {next ? <span className="min-w-0 truncate">{next.title}</span> : null}
                {due ? <span className="shrink-0">{due}</span> : null}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
