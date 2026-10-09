import { engineComputerClient, requireEngine } from "../../engine-client.js";
import type { RouterContext } from "../../routers/context.js";
import {
  engineFollowTopic,
  engineListFeedPosts,
  engineListTopics,
  engineRemoveTopic,
} from "./service.js";

const feedEngine = (actor: Parameters<typeof engineComputerClient>[0]) =>
  requireEngine(engineComputerClient(actor), "The Feed");

/** `feed.*` and `topics.*`: the Posts the Muse wrote and the topics it follows, both read from
 * the engine's scheduled tasks and Goal reports. */
export function feedRouter(c: RouterContext) {
  const { museOnly, deps } = c;
  return {
    feed: {
      list: museOnly.feed.list.handler(({ context, input }) =>
        engineListFeedPosts(deps, feedEngine(context.actor), context.actor, input),
      ),
    },
    topics: {
      list: museOnly.topics.list.handler(({ context, input }) =>
        engineListTopics(deps, feedEngine(context.actor), context.actor, input.botId),
      ),
      follow: museOnly.topics.follow.handler(({ context, input }) =>
        engineFollowTopic(deps, feedEngine(context.actor), context.actor, input),
      ),
      remove: museOnly.topics.remove.handler(({ context, input }) =>
        engineRemoveTopic(deps, feedEngine(context.actor), context.actor, input.topicId),
      ),
    },
  };
}
