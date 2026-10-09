import { getMuseArchiving, updateMuseArchiving } from "../muse-archiving.js";
import { getMuseSettings, updateMuseSettings } from "../muse-settings.js";
import type { RouterContext } from "./context.js";

/** `muse.*`: the Muse's proactivity settings and the Side Chat archiving choice. Archiving moves
 * to features/side-chats with that capability. */
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
      archiving: museOnly.muse.archiving.handler(({ context, input }) =>
        getMuseArchiving(deps, context.actor, input.botId),
      ),
      updateArchiving: museOnly.muse.updateArchiving.handler(({ context, input }) =>
        updateMuseArchiving(deps, context.actor, input),
      ),
    },
  };
}
