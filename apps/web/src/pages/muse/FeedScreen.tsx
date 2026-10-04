import type { Ask, FollowedTopic } from "@aiden/contracts";
import { DEFAULT_MUSE_COLOR, DEFAULT_MUSE_NAME } from "@aiden/contracts";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import { useAsks } from "./asks";
import { CardSkeletonList } from "./feed/CardSkeleton";
import { FeedAsks } from "./feed/FeedAsks";
import { FeedPreview } from "./feed/FeedPreview";
import { PostList } from "./feed/PostList";
import { TopicsCard } from "./feed/TopicsCard";
import { MuseColumn, MuseScreen } from "./ui";

// The Muse's Feed (CONTEXT.md): open Asks pinned on top (from useAsks, shared with the
// Waiting-on-you sheet), then Posts grouped Today / Earlier, then Followed topics as a
// chip row. Ideas live in their own section now (F5), not here.
export function FeedScreen(props: {
  botId: string;
  botName?: string;
  avatarColor?: string;
  onSendIdea?: (text: string) => void;
}) {
  const { botId, botName = DEFAULT_MUSE_NAME, avatarColor = DEFAULT_MUSE_COLOR } = props;
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
    <section>
      <h2 className="px-1 pb-2.5 text-[15px] font-medium text-muted-foreground">
        <Trans>Topics I follow for you</Trans>
      </h2>
      <TopicsCard topics={topics ?? []} onFollow={handleFollowTopic} onRemove={handleRemoveTopic} />
    </section>
  );

  return (
    <MuseScreen>
      <MuseColumn className="flex min-h-full flex-col gap-10 pt-14 pb-16">
        <header>
          <h1 className="text-[34px] font-bold leading-[1.1] tracking-[-0.025em] text-foreground">
            <Trans>Feed</Trans>
          </h1>
          <p className="mt-2 max-w-[560px] text-[17px] leading-[1.45] tracking-[-0.01em] text-muted-foreground">
            <Trans>
              What I finished while you were away, and what's new on the topics you follow.
            </Trans>
          </p>
        </header>

        {loadError ? <p className="text-[13.5px] text-destructive">{loadError}</p> : null}

        {posts === null && !loadError ? (
          <CardSkeletonList />
        ) : empty ? (
          <>
            {topicsSection}
            <section>
              <h2 className="px-1 pb-2.5 text-[15px] font-medium text-muted-foreground">
                <Trans>Example: what a morning with me looks like</Trans>
              </h2>
              <div className="relative">
                <ExampleTag />
                <FeedPreview botName={botName} color={avatarColor} />
              </div>
            </section>
          </>
        ) : (
          <>
            <FeedAsks asks={asks} onAnswer={handleAnswerAsk} />
            {posts ? (
              <PostList
                posts={posts}
                avatarColor={avatarColor}
                nextCursor={nextCursor}
                loadingMore={loadingMore}
                onLoadMore={() => void loadMorePosts()}
              />
            ) : null}
            {topicsSection}
          </>
        )}
      </MuseColumn>
    </MuseScreen>
  );
}

/** Marks sample content so it is never mistaken for the person's own Feed. */
function ExampleTag() {
  return (
    <span className="absolute top-3 end-3 z-10 rounded-full bg-background/80 px-2.5 py-1 text-[12px] font-medium text-muted-foreground ring-1 ring-border/60 backdrop-blur">
      <Trans>Example</Trans>
    </span>
  );
}
