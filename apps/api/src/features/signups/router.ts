import { engineComputerClient } from "../../engine-client.js";
import type { RouterContext } from "../../routers/context.js";
import {
  approveSignup,
  discardSignup,
  pendingSignups,
  rejectSignup,
  restoreSignup,
  signupSettings,
  updateSignupSettings,
} from "./signups.js";

/** `signups.*` (who may join, and who is waiting; the deployment owner only). */
export function signupsRouter(c: RouterContext) {
  const { authed, deps } = c;
  const engine = (actor: { spaceId: string }) => engineComputerClient(actor);
  return {
    signups: {
      settings: authed.signups.settings.handler(({ context }) =>
        signupSettings(deps, context.actor),
      ),
      update: authed.signups.update.handler(({ context, input }) =>
        updateSignupSettings(deps, context.actor, input),
      ),
      pending: authed.signups.pending.handler(({ context }) => pendingSignups(deps, context.actor)),
      approve: authed.signups.approve.handler(({ context, input }) =>
        approveSignup(deps, context.actor, input.userId, engine(context.actor)),
      ),
      restore: authed.signups.restore.handler(({ context, input }) =>
        restoreSignup(deps, context.actor, input.userId, engine(context.actor)),
      ),
      discard: authed.signups.discard.handler(({ context, input }) =>
        discardSignup(deps, context.actor, input.userId, engine(context.actor)),
      ),
      reject: authed.signups.reject.handler(({ context, input }) =>
        rejectSignup(deps, context.actor, input.userId),
      ),
    },
  };
}
