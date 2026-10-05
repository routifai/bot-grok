import { engineComputerClient } from "../engine-computer.js";
import {
  engineAcceptProposal,
  engineDismissProposal,
  engineGetGoal,
  engineGoalLog,
  engineListGoals,
  engineUpdateGoal,
  requireGoalsEngine,
} from "../engine-goals.js";
import { answerAsk, countAsks, listAsks } from "../muse-asks.js";

import type { RouterContext } from "./context.js";

export function goalsRouter(c: RouterContext) {
  const { museOnly, deps } = c;
  return {
    goals: {
      list: museOnly.goals.list.handler(({ context, input }) => {
        const engine = engineComputerClient();
        return engine ? engineListGoals(deps, engine, context.actor, input) : [];
      }),
      get: museOnly.goals.get.handler(({ context, input }) =>
        engineGetGoal(
          deps,
          requireGoalsEngine(engineComputerClient()),
          context.actor,
          input.goalId,
        ),
      ),
      update: museOnly.goals.update.handler(({ context, input }) =>
        engineUpdateGoal(deps, requireGoalsEngine(engineComputerClient()), context.actor, input),
      ),
      acceptProposal: museOnly.goals.acceptProposal.handler(({ context, input }) =>
        engineAcceptProposal(
          deps,
          requireGoalsEngine(engineComputerClient()),
          context.actor,
          input,
        ),
      ),
      dismissProposal: museOnly.goals.dismissProposal.handler(({ context, input }) =>
        engineDismissProposal(
          deps,
          requireGoalsEngine(engineComputerClient()),
          context.actor,
          input,
        ),
      ),
      log: museOnly.goals.log.handler(({ context, input }) =>
        engineGoalLog(
          deps,
          requireGoalsEngine(engineComputerClient()),
          context.actor,
          input.goalId,
        ),
      ),
    },
    asks: {
      list: museOnly.asks.list.handler(({ context, input }) =>
        listAsks(deps, engineComputerClient(), context.actor, input.botId),
      ),
      count: museOnly.asks.count.handler(({ context, input }) =>
        countAsks(deps, engineComputerClient(), context.actor, input.botId),
      ),
      answer: museOnly.asks.answer.handler(({ context, input }) =>
        answerAsk(deps, engineComputerClient(), context.actor, input),
      ),
    },
  };
}
