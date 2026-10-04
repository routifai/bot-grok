import { DEFAULT_MUSE_COLOR, type Goal } from "@aiden/contracts";
import { Skeleton } from "@aiden/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { MUSE_TYPE, MuseColumn, Section } from "../ui";
import { dueMeta, goalDisplayStatus, goalsSummary, taskCounts } from "./format";
import { type GoalStarter, GoalsIntro } from "./GoalsIntro";
import { GoalRing, GoalStep, type GoalStepState, stepStateOf } from "./visuals";

/** The plan steps a card previews: live Tasks, or the proposed first plan before it starts. */
function previewSteps(goal: Goal): { title: string; state: GoalStepState }[] {
  if (goal.tasks.length > 0) {
    return [...goal.tasks]
      .sort((a, b) => a.idx - b.idx)
      .map((task) => ({ title: task.title, state: stepStateOf(task.status) }));
  }
  return (goal.openProposal?.tasks ?? []).map((task) => ({ title: task.title, state: "next" }));
}

const PREVIEW_STEPS = 4;

function GoalCard({
  goal,
  color,
  onSelect,
}: {
  goal: Goal;
  color: string;
  onSelect: (goalId: string) => void;
}) {
  const { t, i18n } = useLingui();
  const { done, total } = taskCounts(goal);
  const due = dueMeta(goal.due, i18n.locale);
  const status = goalDisplayStatus(goal);
  const steps = previewSteps(goal);
  // Show the step being worked on in context: start the preview just before it.
  const firstOpen = Math.max(
    0,
    steps.findIndex((step) => step.state !== "done"),
  );
  const start = Math.max(0, Math.min(firstOpen - 1, steps.length - PREVIEW_STEPS));
  const shown = steps.slice(start, start + PREVIEW_STEPS);
  const hidden = steps.length - shown.length;
  const firstPlan = goal.tasks.length === 0 && goal.openProposal;

  const meta = [
    firstPlan ? t`${steps.length} steps planned` : total > 0 ? t`${done} of ${total}` : null,
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
      className="w-full rounded-[22px] bg-card p-5 text-start shadow-[0_1px_2px_rgb(0_0_0/0.04),0_12px_32px_-14px_rgb(0_0_0/0.16)] ring-1 ring-border/50 transition-[transform,box-shadow] duration-200 hover:shadow-[0_1px_2px_rgb(0_0_0/0.05),0_16px_40px_-14px_rgb(0_0_0/0.22)] active:scale-[0.99] motion-reduce:active:scale-100"
    >
      <div className="flex items-center gap-4">
        <GoalRing value={total > 0 ? done / total : 0} color={color} />
        <div className="min-w-0 flex-1">
          <h3
            className="truncate text-[17px] font-semibold tracking-[-0.02em] text-foreground"
            dir="auto"
          >
            {goal.title}
          </h3>
          <p className="mt-0.5 truncate text-[13.5px] text-muted-foreground">{meta}</p>
        </div>
        {status === "waiting" ? (
          <span className="shrink-0 text-[13px] font-medium text-warning">
            {firstPlan ? <Trans>Plan to review</Trans> : <Trans>Needs you</Trans>}
          </span>
        ) : status === "paused" ? (
          <span className="shrink-0 text-[13px] text-muted-foreground">
            <Trans>Paused</Trans>
          </span>
        ) : status === "working" ? (
          <span className="shrink-0 text-[13px] text-muted-foreground">
            <Trans>Working</Trans>
          </span>
        ) : status === "noPlan" ? (
          <span className="shrink-0 text-[13px] text-muted-foreground">
            <Trans>No plan yet</Trans>
          </span>
        ) : null}
      </div>
      {shown.length > 0 ? (
        <ul className="mt-4 border-t border-border/70 pt-2">
          {shown.map((step, index) => (
            <GoalStep key={`${start + index}-${step.title}`} state={step.state}>
              {step.title}
            </GoalStep>
          ))}
          {hidden > 0 ? (
            <li className="ps-[34px] pt-1 text-[13px] text-muted-foreground">
              <Trans>{hidden} more</Trans>
            </li>
          ) : null}
        </ul>
      ) : null}
    </button>
  );
}

/** Loading placeholder for the Goals list: a few skeleton cards. */
export function GoalListSkeleton() {
  return (
    <MuseColumn className="pt-10">
      <Skeleton className="h-9 w-32" />
      <Skeleton className="mt-3 mb-7 h-4 w-24" />
      <div className="flex flex-col gap-4">
        {[0, 1].map((key) => (
          <div key={key} className="rounded-[22px] bg-card p-5 ring-1 ring-border/50">
            <div className="flex items-center gap-4">
              <Skeleton className="size-12 rounded-full" />
              <div className="flex-1">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="mt-2 h-3 w-1/4" />
              </div>
            </div>
            <Skeleton className="mt-5 h-3 w-2/3" />
            <Skeleton className="mt-3 h-3 w-1/2" />
          </div>
        ))}
      </div>
    </MuseColumn>
  );
}

export function GoalList({
  goals,
  botName,
  onSelect,
  avatarColor,
  starters,
  onSendIdea,
}: {
  goals: Goal[];
  botName: string;
  onSelect: (goalId: string) => void;
  avatarColor?: string;
  starters?: readonly GoalStarter[];
  onSendIdea?: (text: string) => void;
}) {
  const { t } = useLingui();

  if (goals.length === 0) {
    return (
      <GoalsIntro
        botName={botName}
        avatarColor={avatarColor ?? DEFAULT_MUSE_COLOR}
        starters={starters ?? []}
        onStart={onSendIdea}
      />
    );
  }

  const active = goals.filter((goal) => goal.status !== "paused");
  const paused = goals.filter((goal) => goal.status === "paused");
  const { active: activeCount, waiting } = goalsSummary(goals);
  const subtitle =
    waiting > 0 ? t`${activeCount} active · ${waiting} need you` : t`${activeCount} active`;
  const color = avatarColor ?? DEFAULT_MUSE_COLOR;

  return (
    <MuseColumn className="pt-10 pb-16" data-testid="goals-list">
      <h1 className={MUSE_TYPE.pageTitle}>
        <Trans>Goals</Trans>
      </h1>
      <p className="mt-1.5 pb-7 text-[15px] text-muted-foreground">{subtitle}</p>
      <div className="flex flex-col gap-4">
        {active.map((goal) => (
          <GoalCard key={goal.id} goal={goal} color={color} onSelect={onSelect} />
        ))}
      </div>
      {paused.length > 0 ? (
        <Section title={<Trans>Paused</Trans>} className="mt-10">
          <div className="flex flex-col gap-4">
            {paused.map((goal) => (
              <GoalCard key={goal.id} goal={goal} color={color} onSelect={onSelect} />
            ))}
          </div>
        </Section>
      ) : null}
    </MuseColumn>
  );
}
