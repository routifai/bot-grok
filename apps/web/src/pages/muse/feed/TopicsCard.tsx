import type { FollowedTopic } from "@aiden/contracts";
import { cn } from "@aiden/ui-web";
import { useLingui } from "@lingui/react/macro";
import { Plus, X } from "lucide-react";
import { useState } from "react";
import { illustrationUrl } from "../../../lib/illustrations";

const SUGGESTED_TOPICS = [
  "Fintech regulation",
  "AI in banking",
  "Mortgage rates",
  "Canadian markets",
  "Wealth management",
];

const INSET_GROUP =
  "overflow-hidden rounded-[22px] bg-card shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-14px_rgb(0_0_0/0.14)] ring-1 ring-border/60";

/**
 * Followed topics as an iOS-style inset group: follow anything by typing it, follow a
 * suggestion with one tap, and stop following from the row. The Muse researches every
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

  return (
    <div className="flex flex-col gap-3">
      <div className={INSET_GROUP}>
        <form
          className="flex items-center gap-3 px-4"
          onSubmit={(event) => {
            event.preventDefault();
            void follow(draft);
          }}
        >
          <img src={illustrationUrl("globe")} alt="" className="size-8 shrink-0" />
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            aria-label={t`Follow a topic`}
            placeholder={t`Follow a topic, like OSFI guidance`}
            className="min-w-0 flex-1 bg-transparent py-4 text-[16px] tracking-[-0.01em] text-foreground outline-none placeholder:text-muted-foreground"
          />
          <button
            type="submit"
            aria-label={t`Follow`}
            disabled={!draft.trim() || busy !== null}
            className="grid size-8 shrink-0 place-items-center rounded-full bg-foreground text-background transition-opacity disabled:opacity-25 active:scale-95"
          >
            <Plus size={16} strokeWidth={2.25} />
          </button>
        </form>
        {topics.map((topic) => (
          <div key={topic.id} className="flex items-center gap-3 ps-4">
            <span aria-hidden="true" className="size-8 shrink-0" />
            <div className="flex min-w-0 flex-1 items-center gap-3 border-t border-border/70 py-3.5 pe-3">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[16px] tracking-[-0.01em] text-foreground">
                  {topic.topic}
                </span>
                <span className="block text-[13px] text-muted-foreground">
                  {cadenceLabel(topic.cadence)}
                </span>
              </span>
              <button
                type="button"
                aria-label={t`Stop following ${topic.topic}`}
                title={t`Stop following ${topic.topic}`}
                disabled={busy === topic.id}
                onClick={() => void remove(topic)}
                className="grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
              >
                <X size={15} strokeWidth={2} />
              </button>
            </div>
          </div>
        ))}
      </div>

      {suggestions.length > 0 ? (
        <div className="flex flex-wrap gap-2 px-1">
          {suggestions.map((topic) => (
            <button
              key={topic}
              type="button"
              disabled={busy !== null}
              onClick={() => void follow(topic)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full bg-card px-3.5 py-2 text-[14px] text-foreground ring-1 ring-border/70 transition-[transform,background-color] hover:bg-accent/60 active:scale-95 disabled:opacity-50",
                busy === topic && "opacity-50",
              )}
            >
              <Plus
                size={14}
                strokeWidth={2}
                className="text-muted-foreground"
                aria-hidden="true"
              />
              {topic}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
