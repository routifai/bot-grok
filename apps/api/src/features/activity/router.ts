import type { RouterContext } from "../../routers/context.js";
import { getActivity, listActivities, watchActivities } from "./service.js";

/** `activities.*` (the Activity panel, docs/super-chat/WIRING.md slice A1): real handlers in
 * ./service.ts. */
export function activityRouter(c: RouterContext) {
  const { museOnly, deps } = c;
  return {
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
