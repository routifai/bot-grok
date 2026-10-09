import { engineComputerClient } from "../../engine-client.js";
import type { RouterContext } from "../../routers/context.js";
import {
  connectEngineModel,
  disconnectEngineModel,
  engineBudget,
  engineModelCatalog,
  engineModelPreferences,
  engineModelsStatus,
  engineSessionModel,
  listEngineConnections,
  setEngineBudget,
  setEngineDefaultModel,
  setEngineSessionModel,
} from "./service.js";

/** `engineModels.*` (the person's keys, models, budget): thin relays to the engine's model layer
 * (./service.ts). The organization's side is `engineAdmin.*` in ../admin/router.ts. */
export function engineModelsRouter(c: RouterContext) {
  const { authed, deps } = c;
  const engine = (actor: { spaceId: string }) => engineComputerClient(actor);
  return {
    engineModels: {
      status: authed.engineModels.status.handler(({ context }) =>
        engineModelsStatus(deps, engine(context.actor), context.actor),
      ),
      connections: authed.engineModels.connections.handler(({ context }) =>
        listEngineConnections(deps, engine(context.actor), context.actor),
      ),
      connect: authed.engineModels.connect.handler(({ context, input }) =>
        connectEngineModel(deps, engine(context.actor), context.actor, input),
      ),
      disconnect: authed.engineModels.disconnect.handler(({ context, input }) =>
        disconnectEngineModel(deps, engine(context.actor), context.actor, input.provider),
      ),
      catalog: authed.engineModels.catalog.handler(({ context, input }) =>
        engineModelCatalog(deps, engine(context.actor), context.actor, input.harness),
      ),
      preferences: authed.engineModels.preferences.handler(({ context }) =>
        engineModelPreferences(deps, engine(context.actor), context.actor),
      ),
      setDefault: authed.engineModels.setDefault.handler(({ context, input }) =>
        setEngineDefaultModel(deps, engine(context.actor), context.actor, input),
      ),
      budget: authed.engineModels.budget.handler(({ context }) =>
        engineBudget(deps, engine(context.actor), context.actor),
      ),
      setBudget: authed.engineModels.setBudget.handler(({ context, input }) =>
        setEngineBudget(deps, engine(context.actor), context.actor, input),
      ),
      sessionModel: authed.engineModels.sessionModel.handler(({ context, input }) =>
        engineSessionModel(deps, engine(context.actor), context.actor, input.botId),
      ),
      setSessionModel: authed.engineModels.setSessionModel.handler(({ context, input }) =>
        setEngineSessionModel(deps, engine(context.actor), context.actor, input),
      ),
    },
  };
}
