import { Trans, useLingui } from "@lingui/react/macro";
import type { Ask, FollowedTopic } from "@rakazo/contracts";
import { useEffect, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import { useAsks } from "./asks";
import { FeedAsks } from "./feed/FeedAsks";
import { IdeaChips } from "./feed/IdeaChips";
import { PostList } from "./feed/PostList";
import { TopicsRow } from "./feed/TopicsRow";

// The Muse's Feed (CONTEXT.md): open Asks pinned on top (from useAsks, shared with the
// Waiting-on-you sheet), then Posts, newest first;
// Ideas and Followed topics live at the bottom (docs/muse/PLAN.md, F5/F6).
export function FeedScreen(props: { botId: string; onSendIdea: (text: string) => void }) {
  const { botId, onSendIdea } = props;
  const { t } = useLingui();

  const { asks, answer } = useAsks(botId);
  const [posts, setPosts] = useState<Awaited<ReturnType<typeof rpc.feed.list>>["posts"] | null>(
    null,
  );
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [ideas, setIdeas] = useState<Awaited<ReturnType<typeof rpc.ideas.list>> | null>(null);
  const [refreshingIdeas, setRefreshingIdeas] = useState(false);

  const [topics, setTopics] = useState<FollowedTopic[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPosts(null);
    setNextCursor(null);
    setLoadError(null);
    void rpc.feed
      .list({ botId })
      .then((feed) => {
        if (cancelled) return;
        setPosts(feed.posts);
        setNextCursor(feed.nextCursor);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : t`Could not load the Feed.`);
        }
      });
    void rpc.ideas
      .list({ botId })
      .then((list) => {
        if (!cancelled) setIdeas(list);
      })
      .catch(() => {
        if (!cancelled) setIdeas([]);
      });
    void rpc.topics
      .list({ botId })
      .then((list) => {
        if (!cancelled) setTopics(list);
      })
      .catch(() => {
        if (!cancelled) setTopics([]);
      });
    return () => {
      cancelled = true;
    };
  }, [botId, t]);

  async function loadMorePosts() {
    if (!nextCursor || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const page = await rpc.feed.list({ botId, cursor: nextCursor });
      setPosts((current) => (current ?? []).concat(page.posts));
      setNextCursor(page.nextCursor);
    } catch {
      // Keep the current page so Load more can be retried.
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }

  async function handleAnswerAsk(ask: Ask, value: string) {
    await answer({ askId: ask.id, runId: ask.runId, answer: value });
  }

  async function handleRefreshIdeas() {
    if (refreshingIdeas) return;
    setRefreshingIdeas(true);
    try {
      setIdeas(await rpc.ideas.refresh({ botId }));
    } finally {
      setRefreshingIdeas(false);
    }
  }

  async function handleRemoveTopic(topic: FollowedTopic) {
    await rpc.topics.remove({ topicId: topic.id });
    setTopics((current) => current?.filter((candidate) => candidate.id !== topic.id) ?? current);
  }

  return (
    <div className="h-full min-w-0 overflow-y-auto bg-background text-foreground/90">
      <div className="mx-auto flex w-full max-w-[640px] flex-col gap-6 px-6 py-6">
        <h1 className="text-xl font-semibold">
          <Trans>Feed</Trans>
        </h1>

        {loadError ? <p className="text-[13.5px] text-destructive">{loadError}</p> : null}

        {posts === null && !loadError ? (
          <p className="text-[13.5px] text-muted-foreground">
            <Trans>Loading…</Trans>
          </p>
        ) : (
          <>
            <FeedAsks asks={asks} onAnswer={handleAnswerAsk} />
            {posts ? (
              <PostList
                posts={posts}
                nextCursor={nextCursor}
                loadingMore={loadingMore}
                onLoadMore={() => void loadMorePosts()}
              />
            ) : null}
          </>
        )}

        <section className="border-t border-border pt-5">
          <IdeaChips
            ideas={ideas ?? []}
            refreshing={refreshingIdeas}
            onSend={onSendIdea}
            onRefresh={() => void handleRefreshIdeas()}
          />
        </section>

        <section className="border-t border-border pt-5">
          <h2 className="mb-3 text-[13px] font-semibold text-foreground">
            <Trans>Followed topics</Trans>
          </h2>
          <TopicsRow topics={topics ?? []} onRemove={handleRemoveTopic} />
        </section>
      </div>
    </div>
  );
}
