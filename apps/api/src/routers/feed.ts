import { createRepos } from "@aiden/db";
import { ORPCError } from "@orpc/server";
import { engineComputerClient } from "../engine-computer.js";
import {
  engineFollowTopic,
  engineListFeedPosts,
  engineListTopics,
  engineRemoveTopic,
} from "../engine-feed.js";
import { engineAcceptIdea, engineDismissIdea, engineListIdeas } from "../engine-ideas.js";
import { syncEngineProactivity } from "../engine-timezone.js";
import { listAsks } from "../muse-asks.js";
import { followTopic, listFeedPosts, listTopics, removeTopic } from "../muse-feed.js";
import { listIdeas } from "../muse-ideas.js";
import { getMuseSettings, updateMuseSettings } from "../muse-settings.js";

import type { RouterContext } from "./context.js";

export function feedRouter(c: RouterContext) {
  const { museOnly, museIdeasDeps, museFeedDeps, engineIdeasDeps, deps } = c;
  return {
    feed: {
      list: museOnly.feed.list.handler(async ({ context, input }) => {
        const engine = engineComputerClient();
        const [asks, page] = await Promise.all([
          listAsks(deps, engine, context.actor, input.botId),
          engine
            ? engineListFeedPosts(museFeedDeps, engine, context.actor, input.botId)
            : listFeedPosts(museFeedDeps, context.actor, input),
        ]);
        return { asks, posts: page.posts, nextCursor: page.nextCursor };
      }),
    },
    ideas: {
      list: museOnly.ideas.list.handler(({ context, input }) => {
        const engine = engineComputerClient();
        return engine
          ? engineListIdeas(engineIdeasDeps, engine, context.actor, input.botId)
          : listIdeas(museIdeasDeps, context.actor, input.botId);
      }),
      refresh: museOnly.ideas.refresh.handler(({ context, input }) => {
        const engine = engineComputerClient();
        // The engine's Study run refreshes Ideas on its own schedule; reading is the refresh.
        return engine
          ? engineListIdeas(engineIdeasDeps, engine, context.actor, input.botId)
          : listIdeas(museIdeasDeps, context.actor, input.botId);
      }),
      accept: museOnly.ideas.accept.handler(async ({ context, input }) => {
        const engine = engineComputerClient();
        if (engine) return engineAcceptIdea(engineIdeasDeps, engine, context.actor, input);
        const idea = (await listIdeas(museIdeasDeps, context.actor, input.botId)).find(
          (candidate) => candidate.id === input.ideaId,
        );
        if (!idea) throw new ORPCError("NOT_FOUND", { message: "Idea not found" });
        await engineIdeasDeps.sendMessage(context.actor, input.botId, idea.text);
        return { ok: true as const };
      }),
      dismiss: museOnly.ideas.dismiss.handler(async ({ context, input }) => {
        const engine = engineComputerClient();
        if (engine) return engineDismissIdea(engineIdeasDeps, engine, context.actor, input);
        await createRepos(deps.prisma).getBot(context.actor, input.botId);
        return { ok: true as const };
      }),
    },
    topics: {
      list: museOnly.topics.list.handler(({ context, input }) => {
        const engine = engineComputerClient();
        return engine
          ? engineListTopics(museFeedDeps, engine, context.actor, input.botId)
          : listTopics(museFeedDeps, context.actor, input.botId);
      }),
      follow: museOnly.topics.follow.handler(({ context, input }) => {
        const engine = engineComputerClient();
        return engine
          ? engineFollowTopic(museFeedDeps, engine, context.actor, input)
          : followTopic(museFeedDeps, context.actor, input);
      }),
      remove: museOnly.topics.remove.handler(({ context, input }) => {
        const engine = engineComputerClient();
        return engine
          ? engineRemoveTopic(museFeedDeps, engine, context.actor, input.topicId)
          : removeTopic(museFeedDeps, context.actor, input.topicId);
      }),
    },
    muse: {
      settings: museOnly.muse.settings.handler(({ context, input }) =>
        getMuseSettings(deps, context.actor, input.botId),
      ),
      updateSettings: museOnly.muse.updateSettings.handler(async ({ context, input }) => {
        const settings = await updateMuseSettings(deps, context.actor, input);
        await syncEngineProactivity(deps.prisma, context.actor.userId, settings);
        return settings;
      }),
    },
  };
}
