import { Trans, useLingui } from "@lingui/react/macro";
import type { Goal } from "@rakazo/contracts";
import { useEffect, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import { GoalDetail } from "./goals/GoalDetail";
import { GoalList } from "./goals/GoalList";

/**
 * The Goals screen: a list of active and paused Goals, and a detail view (plan, open
 * Proposal, Check-in schedule, and the read-only Goal log) for the one selected.
 * Goals are created by talking to the Muse — there is no "new goal" form here.
 */
export function GoalsScreen({ botId }: { botId: string }) {
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

  if (error) {
    return <p className="p-4 text-[13.5px] text-destructive">{error}</p>;
  }
  if (goals === null) {
    return (
      <p className="p-4 text-[13.5px] text-muted-foreground">
        <Trans>Loading…</Trans>
      </p>
    );
  }

  const selectedGoal = goals.find((goal) => goal.id === selectedGoalId) ?? null;
  if (selectedGoal) {
    return (
      <GoalDetail
        key={selectedGoal.id}
        goal={selectedGoal}
        onBack={() => setSelectedGoalId(null)}
        onChanged={handleChanged}
      />
    );
  }

  return <GoalList goals={goals} onSelect={setSelectedGoalId} />;
}
