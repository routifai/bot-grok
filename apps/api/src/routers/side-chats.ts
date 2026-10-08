import {
  addForkToConversation,
  archiveChat,
  createFork,
  createSideChat,
  getChatProject,
  getChatTranscript,
  listChats,
  markChatRead,
  resetConversation,
  sendToChat,
  summaryPreview,
  unarchiveChat,
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
      createFork: museOnly.chats.createFork.handler(({ context, input }) =>
        createFork(deps, context.actor, input),
      ),
      addToConversation: museOnly.chats.addToConversation.handler(({ context, input }) =>
        addForkToConversation(deps, context.actor, input),
      ),
      archive: museOnly.chats.archive.handler(({ context, input }) =>
        archiveChat(deps, context.actor, input),
      ),
      unarchive: museOnly.chats.unarchive.handler(({ context, input }) =>
        unarchiveChat(deps, context.actor, input),
      ),
      summaryPreview: museOnly.chats.summaryPreview.handler(({ context, input }) =>
        summaryPreview(deps, context.actor, input),
      ),
      transcript: museOnly.chats.transcript.handler(({ context, input }) =>
        getChatTranscript(deps, context.actor, input),
      ),
      markRead: museOnly.chats.markRead.handler(({ context, input }) =>
        markChatRead(deps, context.actor, input),
      ),
      reset: museOnly.chats.reset.handler(({ context, input }) =>
        resetConversation(deps, context.actor, input),
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
