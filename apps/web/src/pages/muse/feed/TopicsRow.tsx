import type { FollowedTopic } from "@aiden/contracts";
import { Button } from "@aiden/ui-web";
import { useLingui } from "@lingui/react/macro";
import { Plus, X } from "lucide-react";
import { useState } from "react";
import { Chip, Section } from "../ui";

// Followed topics are added by talking to the Muse ("follow …"), so there is no add
// form here — a compact chip row with a remove action per topic (CONTEXT.md, "Followed
// topic") and a trailing chip that starts that Conversation.
export function TopicsRow({
  topics,
  onRemove,
  onAddTopic,
}: {
  topics: FollowedTopic[];
  onRemove: (topic: FollowedTopic) => Promise<void>;
  /** Starts a Conversation asking the Muse to follow a new topic. */
  onAddTopic?: () => void;
}) {
  const { t } = useLingui();
  const [removingId, setRemovingId] = useState<string | null>(null);

  async function handleRemove(topic: FollowedTopic) {
    if (removingId) return;
    setRemovingId(topic.id);
    try {
      await onRemove(topic);
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <Section title={t`Followed topics`}>
      <div className="flex flex-wrap gap-2">
        {topics.map((topic) => (
          <span
            key={topic.id}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card py-1 pe-1.5 ps-3 text-[13px] text-foreground"
          >
            {topic.topic}
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t`Stop following ${topic.topic}`}
              title={t`Stop following ${topic.topic}`}
              disabled={removingId === topic.id}
              onClick={() => void handleRemove(topic)}
            >
              <X size={12} strokeWidth={1.75} />
            </Button>
          </span>
        ))}
        {onAddTopic ? (
          <Chip onClick={onAddTopic} className="gap-1">
            <Plus size={13} strokeWidth={1.9} aria-hidden="true" />
            {t`Follow a topic`}
          </Chip>
        ) : null}
      </div>
    </Section>
  );
}
