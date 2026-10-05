import {
  editMemoryClaim,
  forgetMemoryClaim,
  getActivity,
  getMemoryProfile,
  listActivities,
  listDailyNotes,
  listMemoryClaims,
  saveDailyNote,
  watchActivities,
} from "../activities.js";
import { getVaultRequest, listVault, removeVaultEntry, saveVaultEntry } from "../vault.js";

import type { RouterContext } from "./context.js";

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
      dailyNotes: museOnly.memory.dailyNotes.handler(({ context, input }) =>
        listDailyNotes(deps, context.actor, input),
      ),
      saveDailyNote: museOnly.memory.saveDailyNote.handler(({ context, input }) =>
        saveDailyNote(deps, context.actor, input),
      ),
    },
    vault: {
      list: museOnly.vault.list.handler(({ context, input }) =>
        listVault(deps, context.actor, input),
      ),
      remove: museOnly.vault.remove.handler(({ context, input }) =>
        removeVaultEntry(deps, context.actor, input),
      ),
      request: museOnly.vault.request.handler(({ context, input }) =>
        getVaultRequest(deps, context.actor, input),
      ),
      save: museOnly.vault.save.handler(({ context, input }) =>
        saveVaultEntry(deps, context.actor, input),
      ),
    },
    // The Activity panel (docs/super-chat/WIRING.md slice A1) — real handlers in
    // ./activities.js.
    activities: {
      list: museOnly.activities.list.handler(({ context, input }) =>
        listActivities(deps, context.actor, input),
      ),
      get: museOnly.activities.get.handler(({ context, input }) =>
        getActivity(deps, context.actor, input),
      ),
      watch: museOnly.activities.watch.handler(async function* ({ context, input }) {
        yield* watchActivities(deps, context.actor, input, context.signal);
      }),
    },
  };
}
