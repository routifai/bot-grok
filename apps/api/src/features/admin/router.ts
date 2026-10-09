import { engineComputerClient } from "../../engine-client.js";
import type { RouterContext } from "../../routers/context.js";
import { connectEngineModel, disconnectEngineModel, listOrgConnections } from "../models/index.js";
import {
  adminBudget,
  adminModelCatalog,
  adminOverlay,
  adminUsage,
  deleteEngineUser,
  listAdminUsers,
  setAdminOverlay,
  setUserSuspended,
} from "./service.js";

/** `engineAdmin.*` (the organization's keys, models, budget, people and usage; admins only): thin
 * relays to the engine's admin routes (./service.ts). */
export function engineAdminRouter(c: RouterContext) {
  const { authed, deps } = c;
  const engine = (actor: { spaceId: string }) => engineComputerClient(actor);
  return {
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
