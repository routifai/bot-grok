import type { Ask, FollowedTopic } from "@aiden/contracts";
import { DEFAULT_MUSE_NAME } from "@aiden/contracts";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import { useAsks } from "./asks";
import { CardSkeletonList } from "./feed/CardSkeleton";
import { FeedAsks } from "./feed/FeedAsks";
import { PostList } from "./feed/PostList";
import { TopicsRow } from "./feed/TopicsRow";
import { EmptyState, MuseColumn, MuseScreen, ScreenHeader } from "./ui";

const FEED_SUGGESTIONS = ["Follow fintech regulation news", "Follow AI in banking"];

// The Muse's Feed (CONTEXT.md): open Asks pinned on top (from useAsks, shared with the
// Waiting-on-you sheet), then Posts grouped Today / Earlier, then Followed topics as a
// chip row. Ideas live in their own section now (F5), not here.
export function FeedScreen(props: {
  botId: string;
  botName?: string;
  avatarColor?: string;
  onSendIdea?: (text: string) => void;
}) {
  const { botId, avatarColor, onSendIdea } = props;
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

  async function handleRemoveTopic(topic: FollowedTopic) {
    await rpc.topics.remove({ topicId: topic.id });
    setTopics((current) => current?.filter((candidate) => candidate.id !== topic.id) ?? current);
  }

  const empty = posts !== null && posts.length === 0 && asks.length === 0;

  return (
    <MuseScreen header={<ScreenHeader title={t`Feed`} />}>
      <MuseColumn className="flex min-h-full flex-col gap-8 pt-8">
        {loadError ? <p className="text-[13.5px] text-destructive">{loadError}</p> : null}

        {posts === null && !loadError ? (
          <CardSkeletonList />
        ) : empty ? (
          <EmptyState
            avatarColor={avatarColor}
            headline={t`You're all caught up`}
            suggestions={FEED_SUGGESTIONS}
            onSuggestion={onSendIdea}
          >
            <Trans>I'll bring new updates and finished work here.</Trans>
          </EmptyState>
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
          </>
        )}

        <TopicsRow
          topics={topics ?? []}
          onRemove={handleRemoveTopic}
          onAddTopic={onSendIdea ? () => onSendIdea(t`Follow a topic for me`) : undefined}
        />
      </MuseColumn>
    </MuseScreen>
  );
}
