import { useLingui } from "@lingui/react/macro";
import type { ReplyCardDataOf } from "@superchat/contracts";
import { cn } from "@superchat/ui-web";
import { FileText, Sparkles } from "lucide-react";
import { useMemo } from "react";
import { FreshTag, KIND_DOT, KindTag } from "./TopicParts";
import { isFresh } from "./topicTime";
import { useTopicWords } from "./useTopics";

type TopicCardData = ReplyCardDataOf<"topic">;

/** The hero's contour lines, bent into one peak near its bottom-right corner (drawn once). */
function heroContours(): string[] {
  const width = 640;
  const height = 120;
  const [px, py, spread] = [width * 0.82, height * 0.95, 130];
  return Array.from({ length: 14 }, (_, row) => {
    const i = row - 2;
    const points: string[] = [];
    for (let x = 0; x <= width; x += 8) {
      const y0 = ((i + 0.5) * height) / 10;
      const dx = x - px;
      const dy = y0 - py;
      const y =
        y0 +
        Math.sin(x * 0.01 + i) * 2.5 -
        58 * Math.exp(-(dx * dx + dy * dy * 2) / (2 * spread * spread));
      points.push(`${x},${y.toFixed(1)}`);
    }
    return `M${points.join(" L")}`;
  });
}
const HERO_CONTOURS = heroContours();

/**
 * The pick-up card (ADR 0035) the engine adds to the Conversation when the person picks up a
 * topic: where we left off, what we covered, what is still open, and starters. A starter fills
 * the composer for the person to edit or send; it is never sent on its own.
 */
export function TopicCard({
  data,
  onDraft,
}: {
  data: TopicCardData;
  /** Puts a starter in the composer; without it the starters are shown as plain lines. */
  onDraft?: (text: string) => void;
}) {
  const { t } = useLingui();
  const words = useTopicWords();
  const now = useMemo(() => new Date(), []);
  const sources = data.sources ?? {};
  const meta = [
    t`Last touched ${words.when(data.last_touched_at, now)}`,
    [
      sources.chats ? t`${sources.chats} chats` : null,
      sources.files ? t`${sources.files} files` : null,
      sources.emails ? t`${sources.emails} emails` : null,
    ]
      .filter(Boolean)
      .join(" · "),
  ].filter(Boolean);
  const fresh =
    data.since && isFresh({ since: data.since, sinceAt: data.since_at ?? null }, now)
      ? data.since
      : null;
  // Each part rises in turn, top to bottom.
  let step = 0;
  const rise = () => ({ animationDelay: `${250 + step++ * 110}ms` });
  const reveal =
    "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:fill-mode-both motion-safe:animation-duration-600";
  return (
    <article
      data-testid="topic-card-picked"
      aria-label={t`Where we left off on ${data.title}`}
      className={cn(
        "w-[min(46rem,calc(100vw-3rem))] max-w-full overflow-hidden rounded-[22px] border border-line bg-card text-card-foreground shadow-sm",
        reveal,
      )}
    >
      <div className="relative overflow-hidden border-b border-line px-5 pt-[18px] pb-3.5">
        <svg
          aria-hidden="true"
          viewBox="0 0 640 120"
          preserveAspectRatio="none"
          className="pointer-events-none absolute inset-0 size-full text-tint"
        >
          <g fill="none" stroke="currentColor" strokeWidth="1.2">
            {HERO_CONTOURS.map((d, index) => (
              <path
                key={d}
                d={d}
                strokeOpacity={0.05 + 0.16 * Math.max(0, 1 - Math.abs(index - 7) / 7)}
              />
            ))}
          </g>
        </svg>
        <div className="relative text-[11.5px] font-semibold tracking-[0.06em] text-tint-ink uppercase">
          {t`Where we left off`}
        </div>
        <h3 className="relative mt-1 mb-1 text-[24px] font-semibold tracking-[-0.02em]" dir="auto">
          {data.title}
        </h3>
        <div className="relative flex flex-wrap gap-x-3.5 gap-y-1 text-[12.5px] text-ink-2 tabular-nums">
          {meta.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </div>
      </div>
      {data.left_off ? (
        <p className="mx-5 mt-3.5 text-[14px] leading-[1.5]" dir="auto">
          {data.left_off}
        </p>
      ) : null}
      {fresh ? (
        <div
          style={rise()}
          className={cn(
            "mx-5 mt-3.5 flex items-start gap-2.5 rounded-xl bg-ok/15 px-3 py-2.5 text-[13.5px] leading-[1.45]",
            reveal,
          )}
        >
          <FreshTag className="mt-px shrink-0 bg-transparent p-0">{t`New`}</FreshTag>
          <span dir="auto">{fresh}</span>
        </div>
      ) : null}
      <div className="grid grid-cols-1 gap-x-[26px] gap-y-[18px] px-5 pt-4 pb-[18px] md:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        {data.covered.length ? (
          <div>
            <h4 className="mb-2.5 text-[11.5px] font-semibold tracking-[0.06em] text-ink-2 uppercase">
              {t`What we covered`}
            </h4>
            <ol className="relative m-0 flex list-none flex-col gap-3.5 p-0 before:absolute before:start-[5px] before:top-1.5 before:bottom-1.5 before:w-[1.5px] before:bg-line">
              {data.covered.map((line) => (
                <li
                  key={`${line.date}:${line.text}`}
                  style={rise()}
                  className={cn("relative flex flex-col gap-[3px] ps-[22px]", reveal)}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "absolute start-0 top-1 size-3 rounded-full border-2 bg-card",
                      KIND_DOT[line.kind],
                    )}
                  />
                  <span className="flex items-center gap-2 text-[11.5px] text-ink-2 tabular-nums">
                    {words.coveredDay(line.date, now)}
                    <KindTag kind={line.kind} />
                  </span>
                  <span className="text-[13.5px] leading-[1.45]" dir="auto">
                    {line.text}
                  </span>
                  {line.file ? (
                    <span className="mt-[3px] inline-flex items-center gap-1.5 self-start rounded-[9px] border border-line bg-muted/40 px-[9px] py-[5px] text-[12.5px]">
                      <FileText aria-hidden="true" size={14} className="text-tint" />
                      <span dir="auto">{line.file}</span>
                    </span>
                  ) : null}
                </li>
              ))}
            </ol>
          </div>
        ) : null}
        {data.open.length ? (
          <div>
            <h4 className="mb-2.5 text-[11.5px] font-semibold tracking-[0.06em] text-ink-2 uppercase">
              {t`Still open`}
            </h4>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {data.open.map((item) => (
                <li
                  key={`${item.kind}:${item.text}`}
                  style={rise()}
                  className={cn(
                    "flex flex-col gap-1 rounded-xl border border-line bg-muted/40 px-3 py-2.5 text-[13.5px] leading-[1.4]",
                    reveal,
                  )}
                >
                  <span className="self-start">
                    <KindTag kind={item.kind} />
                  </span>
                  <span dir="auto">{item.text}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {data.starters.length ? (
          <div style={rise()} className={cn("col-span-full flex flex-col gap-2 pt-1", reveal)}>
            <h4 className="m-0 text-[11.5px] font-semibold tracking-[0.06em] text-ink-2 uppercase">
              {t`Pick it up`}
            </h4>
            <div className="flex flex-wrap gap-2">
              {data.starters.map((starter) =>
                onDraft ? (
                  <button
                    key={starter}
                    type="button"
                    onClick={() => onDraft(starter)}
                    className="flex max-w-full items-center gap-2 rounded-[14px] border border-tint/30 bg-tint/10 px-[13px] py-[9px] text-start text-[13.5px] leading-[1.35] font-medium text-tint-ink transition-[transform,background-color,border-color] duration-200 hover:border-tint hover:bg-tint/15 focus-visible:outline-2 focus-visible:outline-ring motion-safe:hover:-translate-y-0.5"
                  >
                    <Sparkles aria-hidden="true" size={15} strokeWidth={1.7} className="shrink-0" />
                    <span dir="auto">{starter}</span>
                  </button>
                ) : (
                  <span
                    key={starter}
                    className="rounded-[14px] border border-line px-[13px] py-[9px] text-[13.5px]"
                    dir="auto"
                  >
                    {starter}
                  </span>
                ),
              )}
            </div>
          </div>
        ) : null}
      </div>
    </article>
  );
}
