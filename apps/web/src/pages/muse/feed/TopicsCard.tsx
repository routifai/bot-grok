import type { FollowedTopic } from "@aiden/contracts";
import { cn } from "@aiden/ui-web";
import { useLingui } from "@lingui/react/macro";
import { Plus, X } from "lucide-react";
import { useState } from "react";

const SUGGESTED_TOPICS = [
  "Fintech regulation",
  "AI in banking",
  "Mortgage rates",
  "Canadian markets",
  "Wealth management",
];

/**
 * Followed topics as pills (docs/muse/DESIGN.md "Feed"): each with its own × to stop
 * following, and "Follow a topic" opening a field plus one-tap suggestions (open from the
 * start while nothing is followed). The Muse researches every
 * followed topic on its own schedule and posts what it finds to the Feed.
 */
export function TopicsCard({
  topics,
  onFollow,
  onRemove,
}: {
  topics: readonly FollowedTopic[];
  onFollow: (topic: string) => Promise<void>;
  onRemove: (topic: FollowedTopic) => Promise<void>;
}) {
  const { t } = useLingui();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const followed = new Set(topics.map((topic) => topic.topic.toLowerCase()));
  const suggestions = SUGGESTED_TOPICS.filter((topic) => !followed.has(topic.toLowerCase()));

  async function follow(topic: string) {
    const name = topic.trim();
    if (!name || busy || followed.has(name.toLowerCase())) return;
    setBusy(name);
    try {
      await onFollow(name);
      setDraft("");
    } finally {
      setBusy(null);
    }
  }

  async function remove(topic: FollowedTopic) {
    if (busy) return;
    setBusy(topic.id);
    try {
      await onRemove(topic);
    } finally {
      setBusy(null);
    }
  }

  const cadenceLabel = (cadence: FollowedTopic["cadence"]) =>
    cadence === "weekly"
      ? t`Checked weekly`
      : cadence === "hourly"
        ? t`Checked hourly`
        : t`Checked daily`;

  const adding = addOpen || topics.length === 0;
  const PILL =
    "inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[13px] transition-[filter] focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {topics.map((topic) => (
          <span
            key={topic.id}
            title={cadenceLabel(topic.cadence)}
            className="inline-flex h-8 items-center gap-1 rounded-full bg-selection ps-3.5 pe-1 text-[13px] text-foreground"
          >
            {topic.topic}
            <span className="sr-only"> · {cadenceLabel(topic.cadence)}</span>
            <button
              type="button"
              aria-label={t`Stop following ${topic.topic}`}
              title={t`Stop following ${topic.topic}`}
              disabled={busy === topic.id}
              onClick={() => void remove(topic)}
              className="grid size-6 place-items-center rounded-full text-ink-3 transition-colors hover:bg-selection hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
            >
              <X size={12} strokeWidth={2.25} />
            </button>
          </span>
        ))}
        {adding ? null : (
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className={cn(PILL, "text-link ring-1 ring-separator ring-inset hover:bg-selection")}
          >
            <Plus size={13} strokeWidth={2.25} aria-hidden="true" />
            {t`Follow a topic`}
          </button>
        )}
      </div>

      {adding ? (
        <>
          <form
            className="nova-group flex h-11 max-w-[520px] items-center gap-2 rounded-full ps-4 pe-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              void follow(draft);
            }}
          >
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              aria-label={t`Follow a topic`}
              placeholder={t`Follow a topic, like OSFI guidance`}
              className="min-w-0 flex-1 bg-transparent text-[14px] tracking-[-0.15px] text-foreground outline-none placeholder:text-ink-3"
            />
            <button
              type="submit"
              aria-label={t`Follow`}
              disabled={!draft.trim() || busy !== null}
              className="grid size-8 shrink-0 place-items-center rounded-full bg-tint text-white transition-opacity disabled:bg-selection disabled:text-ink-3 active:scale-95"
            >
              <Plus size={15} strokeWidth={2.25} />
            </button>
          </form>
          {suggestions.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {suggestions.map((topic) => (
                <button
                  key={topic}
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void follow(topic)}
                  className={cn(
                    PILL,
                    "bg-group text-foreground ring-[0.5px] ring-separator ring-inset hover:bg-selection",
                    busy === topic && "opacity-50",
                  )}
                >
                  <Plus size={13} strokeWidth={2} className="text-ink-3" aria-hidden="true" />
                  {topic}
                </button>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
