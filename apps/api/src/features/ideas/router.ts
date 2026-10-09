import { engineComputerClient, requireEngine } from "../../engine-client.js";
import type { RouterContext } from "../../routers/context.js";
import { engineAcceptIdea, engineDismissIdea, engineListIdeas } from "./service.js";

const ideasEngine = (actor: Parameters<typeof engineComputerClient>[0]) =>
  requireEngine(engineComputerClient(actor), "Ideas");

/** `ideas.*`: the engine's suggestions from the standing Study run. */
export function ideasRouter(c: RouterContext) {
  const { museOnly, engineIdeasDeps } = c;
  return {
    ideas: {
      list: museOnly.ideas.list.handler(({ context, input }) =>
        engineListIdeas(engineIdeasDeps, ideasEngine(context.actor), context.actor, input.botId),
      ),
      // The engine's Study run refreshes Ideas on its own schedule; reading is the refresh.
      refresh: museOnly.ideas.refresh.handler(({ context, input }) =>
        engineListIdeas(engineIdeasDeps, ideasEngine(context.actor), context.actor, input.botId),
      ),
      accept: museOnly.ideas.accept.handler(({ context, input }) =>
        engineAcceptIdea(engineIdeasDeps, ideasEngine(context.actor), context.actor, input),
      ),
      dismiss: museOnly.ideas.dismiss.handler(({ context, input }) =>
        engineDismissIdea(engineIdeasDeps, ideasEngine(context.actor), context.actor, input),
      ),
    },
  };
}
