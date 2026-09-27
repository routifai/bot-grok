import { Trans, useLingui } from "@lingui/react/macro";
import type { Idea } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { RefreshCw } from "lucide-react";
import { useMemo } from "react";

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
  const groups = useMemo(() => groupByArea(ideas), [ideas]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-[13px] font-semibold text-foreground">
          <Trans>Ideas</Trans>
        </h2>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t`Refresh ideas`}
          title={t`Refresh ideas`}
          disabled={refreshing}
          onClick={onRefresh}
        >
          <RefreshCw size={14} strokeWidth={1.9} className={refreshing ? "animate-spin" : ""} />
        </Button>
      </div>
      {ideas.length === 0 ? (
        <p className="text-[13.5px] text-muted-foreground">
          <Trans>No ideas right now.</Trans>
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {[...groups.entries()].map(([area, areaIdeas]) => (
            <div key={area} className="flex flex-col gap-1.5">
              <div className="text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground">
                {area}
              </div>
              <div className="flex flex-wrap gap-2">
                {areaIdeas.map((idea) => (
                  <Button
                    key={idea.id}
                    variant="outline"
                    size="sm"
                    className="h-auto whitespace-normal rounded-full px-3 py-1.5 text-start font-normal"
                    onClick={() => onSend(idea.text)}
                  >
                    {idea.text}
                  </Button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
