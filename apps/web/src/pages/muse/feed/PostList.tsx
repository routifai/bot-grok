import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { Post } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { ExternalLink } from "lucide-react";
import { useMemo } from "react";
import { Eyebrow, Section, Surface } from "../ui";
import { formatRelativeDay, groupPostsByRecency, sourceHost } from "./format";

// "Finished while you were away" (docs/muse/DESIGN.md): a Goal report, marked with a
// warning edge like a Task waiting on the person, since it's the Muse catching the
// person up on unattended work.
function GoalReportCard({ post }: { post: Post }) {
  const { t, i18n } = useLingui();
  return (
    <Surface className="flex flex-col gap-2 border-l-2 border-l-warning px-5 py-4">
      <Eyebrow>
        {t`Finished while you were away`} · {formatRelativeDay(post.createdAt, i18n.locale)}
      </Eyebrow>
      <div className="text-[15px] leading-[1.4] font-medium text-foreground">{post.title}</div>
      <div className="text-[14px] leading-[1.55] text-foreground/90">
        <ChatMarkdown>{post.body}</ChatMarkdown>
      </div>
      {post.goalId ? (
        <span className="self-start text-[12.5px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
          <Trans>Open Goal</Trans>
        </span>
      ) : null}
    </Surface>
  );
}

// "Found for you" (docs/muse/DESIGN.md): a finding on a Followed topic, with its source
// host as the eyebrow (a Post carries no topic name of its own) and a two-line summary.
function TopicCard({ post }: { post: Post }) {
  const { t } = useLingui();
  const host = sourceHost(post.sourceUrl);
  return (
    <Surface className="flex flex-col gap-2 px-5 py-4">
      <Eyebrow>{host ?? t`Source`}</Eyebrow>
      <div className="text-[15px] leading-[1.4] font-medium text-foreground">{post.title}</div>
      <p className="line-clamp-2 text-[14px] leading-[1.55] text-foreground/90">{post.body}</p>
      {post.sourceUrl ? (
        <a
          href={post.sourceUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex w-fit items-center gap-1 text-[12.5px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          <Trans>Read</Trans>
          <ExternalLink size={12} strokeWidth={1.9} aria-hidden="true" />
        </a>
      ) : null}
    </Surface>
  );
}

function PostCard({ post }: { post: Post }) {
  return post.kind === "goal_report" ? <GoalReportCard post={post} /> : <TopicCard post={post} />;
}

export function PostList({
  posts,
  nextCursor,
  loadingMore,
  onLoadMore,
}: {
  posts: Post[];
  nextCursor: string | null;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  const { t } = useLingui();
  const { today, earlier } = useMemo(() => groupPostsByRecency(posts), [posts]);

  if (posts.length === 0) {
    return (
      <p className="text-[13.5px] text-muted-foreground">
        <Trans>Nothing in your Feed yet.</Trans>
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-10">
      {today.length > 0 ? (
        <Section title={t`Today`}>
          <div className="flex flex-col gap-3">
            {today.map((post) => (
              <PostCard key={post.id} post={post} />
            ))}
          </div>
        </Section>
      ) : null}
      {earlier.length > 0 ? (
        <Section title={t`Earlier`}>
          <div className="flex flex-col gap-3">
            {earlier.map((post) => (
              <PostCard key={post.id} post={post} />
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
