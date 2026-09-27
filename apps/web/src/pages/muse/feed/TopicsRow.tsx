import { Trans, useLingui } from "@lingui/react/macro";
import type { FollowedTopic } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { X } from "lucide-react";
import { useState } from "react";
import { Section } from "../ui";

// Followed topics are added by talking to the Muse ("follow …"), so there is no add
// form here — only a compact list with a remove action (CONTEXT.md, "Followed topic").
export function TopicsRow({
  topics,
  onRemove,
}: {
  topics: FollowedTopic[];
  onRemove: (topic: FollowedTopic) => Promise<void>;
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
      {topics.length === 0 ? (
        <p className="text-[13.5px] text-muted-foreground">
          <Trans>Not following any topics yet — say "follow …" to the Muse.</Trans>
        </p>
      ) : (
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
        </div>
      )}
    </Section>
  );
}
