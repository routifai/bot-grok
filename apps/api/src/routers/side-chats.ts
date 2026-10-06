import {
  createSideChat,
  getChatMessages,
  getChatProject,
  listChats,
  sendToChat,
  summaryPreview,
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
      messages: museOnly.chats.messages.handler(({ context, input }) =>
        getChatMessages(deps, context.actor, input),
      ),
      send: museOnly.chats.send.handler(({ context, input }) =>
        sendToChat(deps, context.actor, input),
      ),
      project: museOnly.chats.project.handler(({ context, input }) =>
        getChatProject(deps, context.actor, input),
      ),
    },
  };
}
