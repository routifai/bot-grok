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
  setEngineAccountSuspended,
  setUserSuspended,
} from "./service.js";
import {
  approveSignup,
  discardSignup,
  pendingSignups,
  rejectSignup,
  restoreSignup,
  signupSettings,
  updateSignupSettings,
} from "./signups.js";

/** `engineAdmin.*` (the organization's keys, models, budget, people and usage; admins only): thin
 * relays to the engine's admin routes (./service.ts). */
export function engineAdminRouter(c: RouterContext) {
  const { authed, deps } = c;
  const engine = (actor: { spaceId: string }) => engineComputerClient(actor);
  // An account whose space was quarantined had its engine-side work paused; letting the person
  // back in resumes it.
  const keptEmail = async (userId: string) => {
    const kept = await deps.prisma.organization.count({ where: { quarantinedFromUserId: userId } });
    if (kept === 0) return null;
    return (
      (await deps.prisma.user.findUnique({ where: { id: userId }, select: { email: true } }))
        ?.email ?? null
    );
  };
  const resumeEngine = async (actor: { spaceId: string }, email: string | null) => {
    if (email) {
      await setEngineAccountSuspended(deps, engine(actor), email, false).catch(() => undefined);
    }
  };
  return {
    signups: {
      settings: authed.signups.settings.handler(({ context }) =>
        signupSettings(deps, context.actor),
      ),
      update: authed.signups.update.handler(({ context, input }) =>
        updateSignupSettings(deps, context.actor, input),
      ),
      pending: authed.signups.pending.handler(({ context }) => pendingSignups(deps, context.actor)),
      approve: authed.signups.approve.handler(async ({ context, input }) => {
        const kept = await keptEmail(input.userId);
        const result = await approveSignup(deps, context.actor, input.userId);
        await resumeEngine(context.actor, kept);
        return result;
      }),
      restore: authed.signups.restore.handler(async ({ context, input }) => {
        const kept = await keptEmail(input.userId);
        const result = await restoreSignup(deps, context.actor, input.userId);
        await resumeEngine(context.actor, kept);
        return result;
      }),
      discard: authed.signups.discard.handler(({ context, input }) =>
        discardSignup(deps, context.actor, input.userId),
      ),
      reject: authed.signups.reject.handler(({ context, input }) =>
        rejectSignup(deps, context.actor, input.userId),
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
