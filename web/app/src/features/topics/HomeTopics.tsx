import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { Topic } from "@superchat/contracts";
import { cn } from "@superchat/ui-web";
import { ArrowRight } from "lucide-react";
import { useMemo, useState } from "react";
import { FreshTag, SourceCounts, WeekStrip } from "./TopicParts";
import { inRange, isFresh, peakHeat, type TopicRange, weekStrip } from "./topicTime";
import { useTopicWords } from "./useTopics";

/**
 * Home's "Pick up where you left off": one card per topic, under the composer. The last 48 hours
 * by default, this week on the toggle. Each card marks itself `data-peak` so the home's contour
 * ground lifts into a peak under it (higher for recent and busy topics, highest on hover).
 */
export function HomeTopics({
  topics,
  onPick,
}: {
  topics: readonly Topic[] | null;
  onPick: (topic: Topic, from: HTMLElement) => void;
}) {
  const { t } = useLingui();
  const words = useTopicWords();
  const [range, setRange] = useState<TopicRange>("recent");
  const now = useMemo(() => new Date(), [topics]);
  if (!topics?.length) return null;
  const shown = topics.filter((topic) => inRange(topic, range, now));
  const count = shown.length;
  const ranges: { key: TopicRange; label: string }[] = [
    { key: "recent", label: t`Last 48 hours` },
    { key: "week", label: t`This week` },
  ];
  return (
    <section aria-labelledby="home-topics-title" className="flex w-full flex-col gap-3.5">
      <div className="flex flex-wrap items-baseline gap-x-3.5 gap-y-2 px-1">
        <h2 id="home-topics-title" className="text-[15px] font-semibold tracking-[-0.01em]">
          {t`Pick up where you left off`}
        </h2>
        <span className="min-w-[180px] flex-1 text-[13px] text-ink-2">
          {plural(count, {
            one: "# topic from your chats, files and mail",
            other: "# topics from your chats, files and mail",
          })}
        </span>
        <fieldset
          aria-label={t`Range`}
          className="m-0 flex gap-0.5 rounded-[10px] border-0 bg-foreground/6 p-[3px]"
        >
          {ranges.map((item) => (
            <button
              key={item.key}
              type="button"
              aria-pressed={range === item.key}
              onClick={() => setRange(item.key)}
              className={cn(
                "rounded-lg px-[11px] py-[5px] text-[12.5px] font-medium text-ink-2 transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                range === item.key && "bg-solid text-foreground shadow-sm",
              )}
            >
              {item.label}
            </button>
          ))}
        </fieldset>
      </div>
      {count === 0 ? (
        <p className="px-1 text-[13px] text-ink-2">{t`Nothing in the last 48 hours.`}</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
          {shown.map((topic, index) => (
            <button
              key={topic.key}
              type="button"
              data-testid="topic-card"
              data-peak={topic.key}
              data-peak-heat={peakHeat(topic, now)}
              aria-label={t`Pick up ${topic.title}`}
              onClick={(event) => onPick(topic, event.currentTarget)}
              style={{ animationDelay: `${120 + index * 90}ms` }}
              className="group/topic sc-glass relative flex min-w-0 flex-col gap-[9px] rounded-[18px] px-3.5 pt-3.5 pb-3 text-start shadow-sm transition-[transform,box-shadow,border-color] duration-300 ease-[cubic-bezier(.2,.8,.2,1)] hover:border-tint/35 hover:shadow-lg focus-visible:border-tint/35 focus-visible:shadow-lg focus-visible:outline-2 focus-visible:outline-ring motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-4 motion-safe:fill-mode-both motion-safe:animation-duration-700 motion-safe:hover:-translate-y-1.5 motion-safe:focus-visible:-translate-y-1.5"
            >
              <span className="flex items-center gap-2 text-[11.5px] text-ink-2 tabular-nums">
                <span className="flex-1">{words.when(topic.lastTouchedAt, now)}</span>
                <WeekStrip days={weekStrip(topic, now)} />
              </span>
              {isFresh(topic, now) && topic.since ? <FreshTag>{topic.since}</FreshTag> : null}
              <span
                className="text-[15px] leading-tight font-semibold tracking-[-0.01em]"
                dir="auto"
              >
                {topic.title}
              </span>
              <span className="line-clamp-2 text-[13px] leading-[1.45] text-ink-2" dir="auto">
                {topic.leftOff}
              </span>
              <span className="mt-auto flex items-center gap-2.5 pt-0.5 text-[11.5px] text-ink-2">
                <SourceCounts sources={topic.sources} />
                <span className="ms-auto flex items-center gap-1 font-semibold text-tint opacity-0 transition-[opacity,transform] duration-200 group-hover/topic:opacity-100 group-focus-visible/topic:opacity-100 motion-safe:-translate-x-1 motion-safe:group-hover/topic:translate-x-0">
                  {t`Pick up`}
                  <ArrowRight aria-hidden="true" size={13} strokeWidth={2} />
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
