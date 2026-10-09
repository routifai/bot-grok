import type { RouterContext } from "../../routers/context.js";
import {
  editMemoryClaim,
  forgetMemoryClaim,
  getMemoryProfile,
  listMemoryClaims,
} from "./service.js";

/** `memory.*` (the Muse's Memory Profile and the person's editable claims): thin relays to the
 * engine through ./service.ts. Daily notes are `dailyNotes.*` in ../daily-notes/router.ts. */
export function memoryRouter(c: RouterContext) {
  const { museOnly, deps } = c;
  return {
    memory: {
      profile: museOnly.memory.profile.handler(({ context, input }) =>
        getMemoryProfile(deps, context.actor, input),
      ),
      claims: museOnly.memory.claims.handler(({ context, input }) =>
        listMemoryClaims(deps, context.actor, input),
      ),
      editClaim: museOnly.memory.editClaim.handler(({ context, input }) =>
        editMemoryClaim(deps, context.actor, input),
      ),
      forgetClaim: museOnly.memory.forgetClaim.handler(({ context, input }) =>
        forgetMemoryClaim(deps, context.actor, input),
      ),
    },
  };
}
