import { ChatMarkdown } from "@aiden/chat-ui/web";
import type { Post } from "@aiden/contracts";
import { DEFAULT_MUSE_COLOR } from "@aiden/contracts";
import { BotAvatar, Button, Sheet, SheetContent, SheetHeader, SheetTitle } from "@aiden/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { Globe } from "lucide-react";
import { useMemo, useState } from "react";
import { formatRelativeTime } from "../../../lib/relative-time";
import { MUSE_TYPE, Section, Surface } from "../ui";
import { groupPostsByRecency, postPreview } from "./format";

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
          <BotAvatar
            color={avatarColor ?? DEFAULT_MUSE_COLOR}
            identity="aiden"
            face="muse"
            size={18}
          />
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

// "Found for you" (docs/muse/DESIGN.md): a finding on a Followed topic. The engine writes
// markdown, so the card shows a plain preview (first heading as the title, the topic as the
// quiet meta line, domain chips for its sources) and a tap opens the full text.
function TopicCard({ post }: { post: Post }) {
  const [open, setOpen] = useState(false);
  const { heading, text, sources } = useMemo(
    () => postPreview(post.body, post.sourceUrl),
    [post.body, post.sourceUrl],
  );
  const title = heading ?? post.title;
  const meta = [heading ? post.title : null, formatRelativeTime(post.createdAt)]
    .filter(Boolean)
    .join(" · ");
  return (
    <Surface className="flex flex-col gap-3 p-5">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="-m-1 flex flex-col gap-3 rounded-xl p-1 text-start focus-visible:outline-2 focus-visible:outline-ring"
      >
        <span className="flex flex-col gap-1">
          <span className={`line-clamp-2 ${MUSE_TYPE.cardTitle}`} dir="auto">
            {title}
          </span>
          <span className={`truncate ${MUSE_TYPE.meta}`}>{meta}</span>
        </span>
        {text ? (
          <span className={`line-clamp-3 ${MUSE_TYPE.body}`} dir="auto">
            {text}
          </span>
        ) : null}
      </button>
      {sources.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {sources.map((source) => (
            <a
              key={source.url}
              href={source.url}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-[12.5px] text-muted-foreground transition-colors hover:text-foreground"
            >
              <Globe size={12} strokeWidth={1.75} aria-hidden="true" />
              {source.host}
            </a>
          ))}
        </div>
      ) : null}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="flex w-full flex-col gap-0 data-[side=right]:sm:inset-y-3 data-[side=right]:sm:right-3 data-[side=right]:sm:h-auto data-[side=right]:sm:max-w-[560px] data-[side=right]:sm:rounded-3xl data-[side=right]:sm:border data-[side=right]:sm:border-border data-[side=right]:sm:shadow-float">
          <SheetHeader className="gap-1 px-6 pe-14 pt-6 pb-2">
            <SheetTitle
              className="text-[20px] font-semibold tracking-[-0.01em] text-foreground"
              dir="auto"
            >
              {title}
            </SheetTitle>
            <span className={MUSE_TYPE.meta}>{meta}</span>
          </SheetHeader>
          <div
            data-fade-top=""
            className={`rk-scroll flex-1 overflow-y-auto px-6 pt-3 pb-6 ${MUSE_TYPE.body}`}
            dir="auto"
          >
            <ChatMarkdown>
              {heading ? post.body.replace(/^\s*#{1,6}\s+.*\n*/, "") : post.body}
            </ChatMarkdown>
          </div>
        </SheetContent>
      </Sheet>
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
