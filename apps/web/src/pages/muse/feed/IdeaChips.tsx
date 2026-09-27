import type { Idea } from "@aiden/contracts";
import { Button } from "@aiden/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { RefreshCw } from "lucide-react";
import { useMemo } from "react";
import { Chip, Section } from "../ui";

// Grouped by area only past six Ideas (docs/muse/DESIGN.md, "Ideas"): fewer than that,
// the area labels are more chrome than signal.
const GROUP_THRESHOLD = 6;

function groupByArea(ideas: Idea[]): Map<string, Idea[]> {
  const groups = new Map<string, Idea[]>();
  for (const idea of ideas) {
    const group = groups.get(idea.area);
    if (group) group.push(idea);
    else groups.set(idea.area, [idea]);
  }
  return groups;
}

export function IdeaChips({
  ideas,
  refreshing,
  onSend,
  onRefresh,
}: {
  ideas: Idea[];
  refreshing: boolean;
  onSend: (text: string) => void;
  onRefresh: () => void;
}) {
  const { t } = useLingui();
  const groups = useMemo(
    () => (ideas.length > GROUP_THRESHOLD ? groupByArea(ideas) : null),
    [ideas],
  );

  return (
    <Section
      title={t`Things I could start now`}
      action={
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t`Refresh ideas`}
          title={t`Refresh ideas`}
          disabled={refreshing}
          onClick={onRefresh}
        >
          <RefreshCw size={14} strokeWidth={1.75} className={refreshing ? "animate-spin" : ""} />
        </Button>
      }
    >
      {ideas.length === 0 ? (
        <p className="text-[13.5px] text-muted-foreground">
          <Trans>No ideas right now.</Trans>
        </p>
      ) : groups ? (
        <div className="flex flex-col gap-3">
          {[...groups.entries()].map(([area, areaIdeas]) => (
            <div key={area} className="flex flex-col gap-1.5">
              <div className="text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground">
                {area}
              </div>
              <div className="flex flex-wrap gap-2">
                {areaIdeas.map((idea) => (
                  <Chip key={idea.id} onClick={() => onSend(idea.text)}>
                    {idea.text}
                  </Chip>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {ideas.map((idea) => (
            <Chip key={idea.id} onClick={() => onSend(idea.text)}>
              {idea.text}
            </Chip>
          ))}
        </div>
      )}
    </Section>
  );
}
