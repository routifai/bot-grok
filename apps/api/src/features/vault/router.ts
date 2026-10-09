import type { RouterContext } from "../../routers/context.js";
import { getVaultRequest, listVault, removeVaultEntry, saveVaultEntry } from "./service.js";

/** `vault.*` (the person's saved logins): thin relays to the engine through ./service.ts. */
export function vaultRouter(c: RouterContext) {
  const { museOnly, deps } = c;
  return {
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
  };
}
