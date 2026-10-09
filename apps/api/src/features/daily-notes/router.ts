import type { RouterContext } from "../../routers/context.js";
import { listDailyNotes, saveDailyNote } from "./service.js";

/** `dailyNotes.*` (the person's daily notes, engine per owner): thin relays through ./service.ts. */
export function dailyNotesRouter(c: RouterContext) {
  const { museOnly, deps } = c;
  return {
    dailyNotes: {
      list: museOnly.dailyNotes.list.handler(({ context, input }) =>
        listDailyNotes(deps, context.actor, input),
      ),
      save: museOnly.dailyNotes.save.handler(({ context, input }) =>
        saveDailyNote(deps, context.actor, input),
      ),
    },
  };
}
