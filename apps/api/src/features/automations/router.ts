import { engineComputerClient, requireEngine } from "../../engine-client.js";
import type { RouterContext } from "../../routers/context.js";
import {
  engineCreateAutomation,
  engineListAutomations,
  engineRemoveAutomation,
  engineRunAutomation,
  engineUpdateAutomation,
} from "./service.js";

const engine = (actor: Parameters<typeof engineComputerClient>[0]) =>
  requireEngine(engineComputerClient(actor), "Automations");

/** `automations.*`: the person's scheduled prompts, served by the engine's scheduled tasks. */
export function automationsRouter(c: RouterContext) {
  const { authed, deps } = c;
  return {
    automations: {
      list: authed.automations.list.handler(({ context, input }) =>
        engineListAutomations(deps, engine(context.actor), context.actor, input.botId),
      ),
      create: authed.automations.create.handler(({ context, input }) =>
        engineCreateAutomation(deps, engine(context.actor), context.actor, input),
      ),
      update: authed.automations.update.handler(({ context, input }) =>
        engineUpdateAutomation(deps, engine(context.actor), context.actor, input),
      ),
      run: authed.automations.run.handler(({ context, input }) =>
        engineRunAutomation(deps, engine(context.actor), context.actor, input),
      ),
      remove: authed.automations.remove.handler(({ context, input }) =>
        engineRemoveAutomation(deps, engine(context.actor), context.actor, input),
      ),
    },
  };
}
