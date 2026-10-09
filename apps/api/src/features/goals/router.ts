import { engineComputerClient, requireEngine } from "../../engine-client.js";
import type { RouterContext } from "../../routers/context.js";
import {
  engineAcceptProposal,
  engineDismissProposal,
  engineGetGoal,
  engineGoalLog,
  engineListGoals,
  engineUpdateGoal,
} from "./service.js";

const requireGoalsEngine = (client: ReturnType<typeof engineComputerClient>) =>
  requireEngine(client, "Goals");

export function goalsRouter(c: RouterContext) {
  const { museOnly, deps } = c;
  return {
    goals: {
      list: museOnly.goals.list.handler(({ context, input }) =>
        engineListGoals(
          deps,
          requireGoalsEngine(engineComputerClient(context.actor)),
          context.actor,
          input,
        ),
      ),
      get: museOnly.goals.get.handler(({ context, input }) =>
        engineGetGoal(
          deps,
          requireGoalsEngine(engineComputerClient(context.actor)),
          context.actor,
          input.goalId,
        ),
      ),
      update: museOnly.goals.update.handler(({ context, input }) =>
        engineUpdateGoal(
          deps,
          requireGoalsEngine(engineComputerClient(context.actor)),
          context.actor,
          input,
        ),
      ),
      acceptProposal: museOnly.goals.acceptProposal.handler(({ context, input }) =>
        engineAcceptProposal(
          deps,
          requireGoalsEngine(engineComputerClient(context.actor)),
          context.actor,
          input,
        ),
      ),
      dismissProposal: museOnly.goals.dismissProposal.handler(({ context, input }) =>
        engineDismissProposal(
          deps,
          requireGoalsEngine(engineComputerClient(context.actor)),
          context.actor,
          input,
        ),
      ),
      log: museOnly.goals.log.handler(({ context, input }) =>
        engineGoalLog(
          deps,
          requireGoalsEngine(engineComputerClient(context.actor)),
          context.actor,
          input.goalId,
        ),
      ),
    },
  };
}
