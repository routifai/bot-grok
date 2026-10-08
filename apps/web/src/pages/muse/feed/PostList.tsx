import { ChatMarkdown } from "@aiden/chat-ui/web";
import type { Post } from "@aiden/contracts";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@aiden/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { Globe } from "lucide-react";
import { useMemo, useState } from "react";
import { formatRelativeTime } from "../../../lib/relative-time";
import { MUSE_TYPE, QUIET_BUTTON, Section } from "../ui";
import { groupPostsByRecency, postPreview } from "./format";

type TileTone = "blue" | "warm" | "pink" | "green";
const TOPIC_TONES: TileTone[] = ["blue", "warm", "pink"];

/**
 * One Post as a media tile (docs/muse/DESIGN.md "Feed"): a dark card with a colored glow, a
 * small uppercase kicker (the topic, or "From your goal") with the time, the title, a short
 * preview, its sources, and a white "Read" pill that opens the full text. A Goal report glows
 * green; topic findings cycle blue, warm and pink.
 */
function PostTile({ post, index }: { post: Post; index: number }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const goalReport = post.kind === "goal_report";
  const { heading, text, sources } = useMemo(
    () => postPreview(post.body, goalReport ? null : post.sourceUrl),
    [post.body, post.sourceUrl, goalReport],
  );
  const title = goalReport ? post.title : (heading ?? post.title);
  const when = formatRelativeTime(post.createdAt);
  const kicker = goalReport
    ? t`From your goal · ${when}`
    : [heading ? post.title : null, when].filter(Boolean).join(" · ");
  const tone: TileTone = goalReport ? "green" : (TOPIC_TONES[index % TOPIC_TONES.length] ?? "blue");
  const body = goalReport
    ? post.body
    : heading
      ? post.body.replace(/^\s*#{1,6}\s+.*\n*/, "")
      : post.body;

  return (
    <article
      data-testid="feed-post"
      data-tone={tone}
      className="nova-media relative flex min-h-[230px] min-w-0 flex-col justify-between gap-4 overflow-hidden rounded-[28px] p-[22px] text-white"
    >
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="-m-1 flex flex-col gap-1.5 rounded-2xl p-1 text-start focus-visible:outline-2 focus-visible:outline-ring"
      >
        <span className="truncate text-[12px] font-semibold tracking-[0.02em] text-white/80 uppercase">
          {kicker}
        </span>
        <span
          className="line-clamp-3 text-[22px] leading-[1.15] font-semibold tracking-[0.1px] text-balance"
          dir="auto"
        >
          {title}
        </span>
        {text ? (
          <span className="line-clamp-2 text-[13.5px] leading-[1.4] text-white/75" dir="auto">
            {text}
          </span>
        ) : null}
      </button>
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="h-10 shrink-0 rounded-full bg-white px-5 text-[15px] font-medium tracking-[-0.24px] text-black transition-[filter] hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {t`Read`}
        </button>
        {sources.length > 0 ? (
          <span className="flex min-w-0 flex-wrap gap-x-2 gap-y-1 text-[12.5px] text-white/75">
            {sources.map((source) => (
              <a
                key={source.url}
                href={source.url}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 rounded-full transition-colors hover:text-white"
              >
                <Globe size={12} strokeWidth={1.75} aria-hidden="true" />
                {source.host}
              </a>
            ))}
          </span>
        ) : null}
      </div>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="flex w-full flex-col gap-0 data-[side=right]:sm:inset-y-3 data-[side=right]:sm:right-3 data-[side=right]:sm:h-auto data-[side=right]:sm:max-w-[560px] data-[side=right]:sm:rounded-3xl data-[side=right]:sm:border data-[side=right]:sm:border-border data-[side=right]:sm:shadow-float">
          <SheetHeader className="gap-1 px-6 pe-14 pt-6 pb-2">
            <SheetTitle
              className="text-[20px] font-semibold tracking-[-0.01em] text-foreground"
              dir="auto"
            >
              {title}
            </SheetTitle>
            <span className={MUSE_TYPE.meta}>{kicker}</span>
          </SheetHeader>
          <div
            data-fade-top=""
            className={`rk-scroll flex-1 overflow-y-auto px-6 pt-3 pb-6 ${MUSE_TYPE.body}`}
            dir="auto"
          >
            <ChatMarkdown>{body}</ChatMarkdown>
          </div>
        </SheetContent>
      </Sheet>
    </article>
  );
}

const POST_GRID = "grid grid-cols-1 gap-3.5 md:grid-cols-[1.4fr_1fr]";

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

  return (
    <div className="flex flex-col gap-6">
      {today.length > 0 ? (
        <Section title={t`Today`}>
          <div className={POST_GRID}>
            {today.map((post, index) => (
              <PostTile key={post.id} post={post} index={index} />
            ))}
          </div>
        </Section>
      ) : null}
      {earlier.length > 0 ? (
        <Section title={t`Earlier`}>
          <div className={POST_GRID}>
            {earlier.map((post, index) => (
              <PostTile key={post.id} post={post} index={today.length + index} />
            ))}
          </div>
        </Section>
      ) : null}
      {nextCursor ? (
        <div className="flex justify-center">
          <button
            type="button"
            className={QUIET_BUTTON}
            disabled={loadingMore}
            onClick={onLoadMore}
          >
            {loadingMore ? <Trans>Loading…</Trans> : <Trans>Load more</Trans>}
          </button>
        </div>
      ) : null}
    </div>
  );
}
