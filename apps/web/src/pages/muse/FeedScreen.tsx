import { Trans, useLingui } from "@lingui/react/macro";
import type { Ask, FollowedTopic } from "@nova/contracts";
import { useEffect, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import { useAsks } from "./asks";
import { FeedGlyph } from "./chrome/NovaGlyphs";
import { NovaTile } from "./chrome/NovaTile";
import { CardSkeletonList } from "./feed/CardSkeleton";
import { FeedAsks } from "./feed/FeedAsks";
import { FeedPreview } from "./feed/FeedPreview";
import { PostList } from "./feed/PostList";
import { TopicsCard } from "./feed/TopicsCard";
import { MuseScreen, MuseWideCenter, ScreenHeader, ScreenHero } from "./ui";

// The Muse's Feed (CONTEXT.md): open Asks pinned on top (from useAsks, shared with the
// Waiting-on-you sheet), then Posts grouped Today / Earlier, then Followed topics as a
// chip row. Ideas live in their own section now (F5), not here.
export function FeedScreen(props: { botId: string; onSendIdea?: (text: string) => void }) {
  const { botId } = props;
  const { t } = useLingui();

  const { asks, answer } = useAsks(botId);
  const [posts, setPosts] = useState<Awaited<ReturnType<typeof rpc.feed.list>>["posts"] | null>(
    null,
  );
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  const [loadError, setLoadError] = useState<string | null>(null);

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

  async function handleFollowTopic(topic: string) {
    const followed = await rpc.topics.follow({ botId, topic });
    setTopics((current) => [...(current ?? []), followed]);
  }

  async function handleRemoveTopic(topic: FollowedTopic) {
    await rpc.topics.remove({ topicId: topic.id });
    setTopics((current) => current?.filter((candidate) => candidate.id !== topic.id) ?? current);
  }

  const empty =
    posts !== null &&
    posts.length === 0 &&
    asks.length === 0 &&
    topics !== null &&
    topics.length === 0;

  const topicsSection = (
    <section aria-labelledby="feed-topics" className="flex flex-col gap-2">
      <h2 id="feed-topics" className="sr-only">
        <Trans>Topics I follow for you</Trans>
      </h2>
      <TopicsCard topics={topics ?? []} onFollow={handleFollowTopic} onRemove={handleRemoveTopic} />
    </section>
  );

  return (
    <MuseScreen header={<ScreenHeader title={t`Feed`} dragRegion />}>
      <MuseWideCenter className="min-h-full">
        <ScreenHero
          tile={
            <NovaTile tone="red" size={44}>
              <FeedGlyph />
            </NovaTile>
          }
          title={<Trans>Feed</Trans>}
          subtitle={
            <Trans>
              What I finished while you were away, and what's new on the topics you follow.
            </Trans>
          }
        />

        {topics !== null ? topicsSection : null}

        {loadError ? <p className="text-[13.5px] text-destructive">{loadError}</p> : null}

        {posts === null && !loadError ? (
          <CardSkeletonList />
        ) : empty ? (
          <section className="pt-2">
            <h2 className="px-1 pb-2.5 text-[13px] font-semibold text-foreground">
              <Trans>Example: what a morning with me looks like</Trans>
            </h2>
            <div className="relative">
              <ExampleTag />
              <FeedPreview />
            </div>
          </section>
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
      </MuseWideCenter>
    </MuseScreen>
  );
}

/** Marks sample content so it is never mistaken for the person's own Feed. */
function ExampleTag() {
  return (
    <span className="absolute top-3 end-3 z-10 rounded-full bg-selection px-2.5 py-1 text-[12px] font-medium text-ink-2 backdrop-blur">
      <Trans>Example</Trans>
    </span>
  );
}
