import { getMuseSettings, updateMuseSettings } from "../muse-settings.js";
import type { RouterContext } from "./context.js";

/** `muse.*`: the Muse's proactivity settings. */
export function museRouter(c: RouterContext) {
  const { museOnly, deps } = c;
  return {
    muse: {
      settings: museOnly.muse.settings.handler(({ context, input }) =>
        getMuseSettings(deps, context.actor, input.botId),
      ),
      updateSettings: museOnly.muse.updateSettings.handler(({ context, input }) =>
        updateMuseSettings(deps, context.actor, input),
      ),
    },
  };
}
