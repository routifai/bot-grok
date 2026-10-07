import {
  createSideChat,
  getChatProject,
  getChatTranscript,
  listChats,
  sendToChat,
  summaryPreview,
  watchFamily,
} from "../chats.js";

import type { RouterContext } from "./context.js";

export function sideChatsRouter(c: RouterContext) {
  const { museOnly, deps } = c;
  return {
    // Super Chat Side Chats and Helpers (docs/super-chat/WIRING.md slice A1) — real handlers in
    // ./chats.js; the ownership rule and Omnigent mapping live in @aiden/adapters.
    chats: {
      list: museOnly.chats.list.handler(({ context, input }) =>
        listChats(deps, context.actor, input),
      ),
      createSide: museOnly.chats.createSide.handler(({ context, input }) =>
        createSideChat(deps, context.actor, input),
      ),
      summaryPreview: museOnly.chats.summaryPreview.handler(({ context, input }) =>
        summaryPreview(deps, context.actor, input),
      ),
      transcript: museOnly.chats.transcript.handler(({ context, input }) =>
        getChatTranscript(deps, context.actor, input),
      ),
      watch: museOnly.chats.watch.handler(async function* ({ context, input }) {
        yield* watchFamily(deps, context.actor, input, context.signal);
      }),
      send: museOnly.chats.send.handler(({ context, input }) =>
        sendToChat(deps, context.actor, input),
      ),
      project: museOnly.chats.project.handler(({ context, input }) =>
        getChatProject(deps, context.actor, input),
      ),
    },
  };
}
