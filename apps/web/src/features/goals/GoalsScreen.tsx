import { useLingui } from "@lingui/react/macro";
import type { Goal } from "@nova/contracts";
import { DEFAULT_MUSE_NAME } from "@nova/contracts";
import { useEffect, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import { MuseColumn, MuseScreen, ScreenHeader } from "../../pages/muse/ui";
import { GoalDetail } from "./GoalDetail";
import { GoalList, GoalListSkeleton } from "./GoalList";
import type { GoalStarter } from "./GoalsIntro";

const GOAL_STARTERS: readonly GoalStarter[] = [
  {
    illustration: "briefcase",
    title: "Prep the Q3 client portfolio review",
    detail:
      "I'll pull each client's holdings and returns, flag drift from their target mix, and draft talking points before every meeting.",
    prompt: "Help me prepare the Q3 client portfolio review for my book of clients.",
  },
  {
    illustration: "graduation-cap",
    title: "Get my CFA Level II study plan on track",
    detail:
      "A weekly plan to exam day. I'll check in on the hard readings and quiz you on the formulas you keep missing.",
    prompt: "Make me a CFA Level II study plan to exam day and keep me on track.",
  },
  {
    illustration: "bar-chart",
    title: "Automate my weekly branch KPI summary",
    detail:
      "Every Monday I'll gather last week's numbers, compare them to target, and send you a one-page summary to review.",
    prompt: "Every Monday, put together my branch KPI summary for last week versus target.",
  },
];

/**
 * The Goals screen: a list of active and paused Goals, and a detail view (plan, open
 * Proposal, Check-in schedule, and the read-only Goal log) for the one selected.
 * Goals are created by talking to the Muse — there is no "new goal" form here.
 */
export function GoalsScreen({
  botId,
  botName,
  onSendIdea,
}: {
  botId: string;
  botName?: string;
  /** Starts a Conversation with a suggestion from the empty state. */
  onSendIdea?: (text: string) => void;
}) {
  const { t } = useLingui();
  const [goals, setGoals] = useState<Goal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedGoalId, setSelectedGoalId] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    setGoals(null);
    setError(null);
    setSelectedGoalId(null);
    void rpc.goals
      .list({ botId })
      .then((list) => {
        if (current !== generation.current) return;
        setGoals(list);
      })
      .catch(() => {
        if (current !== generation.current) return;
        setError(t`Could not load Goals`);
      });
    return () => {
      generation.current += 1;
    };
  }, [botId, t]);

  function handleChanged(updated: Goal) {
    setGoals((current) => {
      if (!current) return current;
      if (updated.status !== "active" && updated.status !== "paused") {
        return current.filter((goal) => goal.id !== updated.id);
      }
      const exists = current.some((goal) => goal.id === updated.id);
      return exists
        ? current.map((goal) => (goal.id === updated.id ? updated : goal))
        : [updated, ...current];
    });
  }

  const selectedGoal = goals?.find((goal) => goal.id === selectedGoalId) ?? null;

  return (
    <MuseScreen header={<ScreenHeader title={t`Goals`} dragRegion />}>
      {error ? (
        <MuseColumn>
          <p className="pt-12 text-[13.5px] text-destructive">{error}</p>
        </MuseColumn>
      ) : goals === null ? (
        <GoalListSkeleton />
      ) : selectedGoal ? (
        <GoalDetail
          key={selectedGoal.id}
          goal={selectedGoal}
          onBack={() => setSelectedGoalId(null)}
          onChanged={handleChanged}
          onPlanIt={
            onSendIdea
              ? (goal) => onSendIdea(t`Please propose a plan for my goal "${goal.title}".`)
              : undefined
          }
        />
      ) : (
        <GoalList
          goals={goals}
          botName={botName ?? DEFAULT_MUSE_NAME}
          onSelect={setSelectedGoalId}
          onChanged={handleChanged}
          starters={GOAL_STARTERS}
          onSendIdea={onSendIdea}
        />
      )}
    </MuseScreen>
  );
}
