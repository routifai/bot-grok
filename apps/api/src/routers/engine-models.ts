import { engineComputerClient } from "../engine-computer.js";
import {
  adminBudget,
  adminModelCatalog,
  adminOverlay,
  adminUsage,
  connectEngineModel,
  deleteEngineUser,
  disconnectEngineModel,
  engineBudget,
  engineModelCatalog,
  engineModelPreferences,
  engineModelsStatus,
  engineSessionModel,
  listAdminUsers,
  listEngineConnections,
  listOrgConnections,
  setAdminOverlay,
  setEngineBudget,
  setEngineDefaultModel,
  setEngineSessionModel,
  setUserSuspended,
} from "../engine-models.js";
import type { RouterContext } from "./context.js";

/** `engineModels.*` (the person's keys, models, budget) and `engineAdmin.*` (the organization's,
 * admins only): thin relays to the engine's model layer (../engine-models.ts). */
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
    engineAdmin: {
      connections: authed.engineAdmin.connections.handler(({ context }) =>
        listOrgConnections(deps, engine(context.actor), context.actor),
      ),
      connect: authed.engineAdmin.connect.handler(({ context, input }) =>
        connectEngineModel(deps, engine(context.actor), context.actor, input, "org"),
      ),
      disconnect: authed.engineAdmin.disconnect.handler(({ context, input }) =>
        disconnectEngineModel(deps, engine(context.actor), context.actor, input.provider, "org"),
      ),
      models: authed.engineAdmin.models.handler(({ context }) =>
        adminOverlay(deps, engine(context.actor), context.actor),
      ),
      modelsCatalog: authed.engineAdmin.modelsCatalog.handler(({ context, input }) =>
        adminModelCatalog(deps, engine(context.actor), context.actor, input.harness),
      ),
      setModels: authed.engineAdmin.setModels.handler(({ context, input }) =>
        setAdminOverlay(deps, engine(context.actor), context.actor, input.harnesses),
      ),
      budget: authed.engineAdmin.budget.handler(({ context }) =>
        adminBudget(deps, engine(context.actor), context.actor),
      ),
      setBudget: authed.engineAdmin.setBudget.handler(({ context, input }) =>
        adminBudget(deps, engine(context.actor), context.actor, input),
      ),
      users: authed.engineAdmin.users.handler(({ context }) =>
        listAdminUsers(deps, engine(context.actor), context.actor),
      ),
      usage: authed.engineAdmin.usage.handler(({ context, input }) =>
        adminUsage(deps, engine(context.actor), context.actor, input.window),
      ),
      setSuspended: authed.engineAdmin.setSuspended.handler(({ context, input }) =>
        setUserSuspended(deps, engine(context.actor), context.actor, input),
      ),
      deleteUser: authed.engineAdmin.deleteUser.handler(({ context, input }) =>
        deleteEngineUser(deps, engine(context.actor), context.actor, input.userId),
      ),
    },
  };
}
