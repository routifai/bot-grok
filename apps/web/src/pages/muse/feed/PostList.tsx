import { ChatMarkdown } from "@aiden/chat-ui/web";
import type { Post } from "@aiden/contracts";
import { BotAvatar, Button } from "@aiden/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { ExternalLink, Globe } from "lucide-react";
import { useMemo } from "react";
import { formatRelativeTime } from "../../../lib/relative-time";
import { MUSE_TYPE, Section, Surface } from "../ui";
import { groupPostsByRecency, sourceHost } from "./format";

// "Finished while you were away" (docs/muse/DESIGN.md): a Goal report, in the same plain
// card as every other Post — no accent bar, just the Muse's own face marking whose work
// this is.
function GoalReportCard({ post, avatarColor }: { post: Post; avatarColor?: string }) {
  const { t } = useLingui();
  return (
    <Surface className="flex flex-col gap-3 p-5">
      <h3 className={MUSE_TYPE.cardTitle}>{post.title}</h3>
      <div className={MUSE_TYPE.body}>
        <ChatMarkdown>{post.body}</ChatMarkdown>
      </div>
      <div className="flex items-center justify-between gap-3 pt-1">
        <span className={`flex items-center gap-2 ${MUSE_TYPE.meta}`}>
          <BotAvatar color={avatarColor} identity="aiden" face="muse" size={18} />
          {t`From your goal · ${formatRelativeTime(post.createdAt)}`}
        </span>
        {post.goalId ? (
          <Button variant="ghost" size="sm" className="text-muted-foreground">
            <Trans>Open goal</Trans>
          </Button>
        ) : null}
      </div>
    </Surface>
  );
}

// "Found for you" (docs/muse/DESIGN.md): a finding on a Followed topic, its source host
// as a quiet meta line (not a shouting eyebrow) and a two-line summary.
function TopicCard({ post }: { post: Post }) {
  const { t } = useLingui();
  const host = sourceHost(post.sourceUrl);
  return (
    <Surface className="flex flex-col gap-3 p-5">
      <h3 className={MUSE_TYPE.cardTitle}>{post.title}</h3>
      <p className={`line-clamp-2 ${MUSE_TYPE.body}`}>{post.body}</p>
      <div className="flex items-center justify-between gap-3 pt-1">
        <span className={`flex items-center gap-1.5 ${MUSE_TYPE.meta}`}>
          <Globe size={14} strokeWidth={1.75} aria-hidden="true" />
          {host ?? t`Source`}
        </span>
        {post.sourceUrl ? (
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-muted-foreground"
            render={<a href={post.sourceUrl} target="_blank" rel="noreferrer noopener" />}
          >
            <Trans>Read</Trans>
            <ExternalLink size={13} strokeWidth={1.9} aria-hidden="true" />
          </Button>
        ) : null}
      </div>
    </Surface>
  );
}

function PostCard({ post, avatarColor }: { post: Post; avatarColor?: string }) {
  return post.kind === "goal_report" ? (
    <GoalReportCard post={post} avatarColor={avatarColor} />
  ) : (
    <TopicCard post={post} />
  );
}

export function PostList({
  posts,
  avatarColor,
  nextCursor,
  loadingMore,
  onLoadMore,
}: {
  posts: Post[];
  avatarColor?: string;
  nextCursor: string | null;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  const { t } = useLingui();
  const { today, earlier } = useMemo(() => groupPostsByRecency(posts), [posts]);

  return (
    <div className="flex flex-col gap-8">
      {today.length > 0 ? (
        <Section title={t`Today`}>
          <div className="flex flex-col gap-3">
            {today.map((post) => (
              <PostCard key={post.id} post={post} avatarColor={avatarColor} />
            ))}
          </div>
        </Section>
      ) : null}
      {earlier.length > 0 ? (
        <Section title={t`Earlier`}>
          <div className="flex flex-col gap-3">
            {earlier.map((post) => (
              <PostCard key={post.id} post={post} avatarColor={avatarColor} />
            ))}
          </div>
        </Section>
      ) : null}
      {nextCursor ? (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" disabled={loadingMore} onClick={onLoadMore}>
            {loadingMore ? <Trans>Loading…</Trans> : <Trans>Load more</Trans>}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
