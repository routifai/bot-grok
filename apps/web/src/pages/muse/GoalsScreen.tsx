import type { Goal } from "@aiden/contracts";
import { DEFAULT_MUSE_NAME } from "@aiden/contracts";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import { GoalDetail } from "./goals/GoalDetail";
import { GoalList, GoalListSkeleton } from "./goals/GoalList";
import { MuseColumn, MuseScreen, ScreenHeader } from "./ui";

const GOAL_SUGGESTIONS = [
  "Prep the Q3 client portfolio review",
  "Get my CFA Level II study plan on track",
  "Automate my weekly branch KPI summary",
];

/**
 * The Goals screen: a list of active and paused Goals, and a detail view (plan, open
 * Proposal, Check-in schedule, and the read-only Goal log) for the one selected.
 * Goals are created by talking to the Muse — there is no "new goal" form here.
 */
export function GoalsScreen({
  botId,
  botName,
  avatarColor,
  onSendIdea,
}: {
  botId: string;
  botName?: string;
  /** The Muse's identity color, for the empty state's face. */
  avatarColor?: string;
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
    <MuseScreen header={<ScreenHeader title={<Trans>Goals</Trans>} />}>
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
        />
      ) : (
        <GoalList
          goals={goals}
          botName={botName ?? DEFAULT_MUSE_NAME}
          onSelect={setSelectedGoalId}
          avatarColor={avatarColor}
          suggestions={GOAL_SUGGESTIONS}
          onSendIdea={onSendIdea}
        />
      )}
    </MuseScreen>
  );
}
