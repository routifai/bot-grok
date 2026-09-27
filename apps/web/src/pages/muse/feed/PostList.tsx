import { Trans } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { Post } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { ExternalLink, Target } from "lucide-react";
import { formatRelativeTime } from "../../../lib/relative-time";

// A Post's source is encoded as an icon + text label (never color alone): a Goal report
// shows the Goal it came from as a label — the shell wires real navigation to the Goals
// screen later, decisions 9-10, docs/muse/PLAN.md — and a topic finding links to its
// `sourceUrl` in a new tab.
function PostSource({ post }: { post: Post }) {
  if (post.kind === "goal_report") {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <Target size={13} strokeWidth={1.9} aria-hidden="true" />
        <Trans>Goal</Trans>
      </span>
    );
  }
  if (!post.sourceUrl) return null;
  return (
    <a
      href={post.sourceUrl}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-center gap-1 text-primary hover:underline"
    >
      <ExternalLink size={13} strokeWidth={1.9} aria-hidden="true" />
      <Trans>Source</Trans>
    </a>
  );
}

function PostCard({ post }: { post: Post }) {
  return (
    <div className="rounded-2xl border border-border bg-card px-5 py-4">
      <div className="text-[15px] font-semibold text-foreground">{post.title}</div>
      <div className="mt-1.5 text-[14px] leading-[1.55] text-foreground/90">
        <ChatMarkdown>{post.body}</ChatMarkdown>
      </div>
      <div className="mt-3 flex items-center gap-2 text-[12px]">
        <PostSource post={post} />
        <span aria-hidden="true" className="text-muted-foreground">
          ·
        </span>
        <span className="text-muted-foreground">{formatRelativeTime(post.createdAt)}</span>
      </div>
    </div>
  );
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
  if (posts.length === 0) {
    return (
      <p className="text-[13.5px] text-muted-foreground">
        <Trans>Nothing in your Feed yet.</Trans>
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {posts.map((post) => (
        <PostCard key={post.id} post={post} />
      ))}
      {nextCursor ? (
        <div className="mt-1 flex justify-center">
          <Button variant="outline" size="sm" disabled={loadingMore} onClick={onLoadMore}>
            {loadingMore ? <Trans>Loading…</Trans> : <Trans>Load more</Trans>}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
