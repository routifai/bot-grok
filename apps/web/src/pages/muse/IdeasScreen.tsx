import type { Idea } from "@aiden/contracts";
import { Button, cn, Skeleton } from "@aiden/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { ArrowRight, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import { areaLabel, ideaIcon } from "./ideas/areaIcon";
import { EmptyState, MUSE_TYPE, MuseColumn, MuseScreen, ScreenHeader } from "./ui";

/** Ideas kept in the order their area first appeared, not re-sorted alphabetically. */
function groupByArea(ideas: Idea[]): { area: string; ideas: Idea[] }[] {
  const order: string[] = [];
  const groups = new Map<string, Idea[]>();
  for (const idea of ideas) {
    const existing = groups.get(idea.area);
    if (existing) existing.push(idea);
    else {
      groups.set(idea.area, [idea]);
      order.push(idea.area);
    }
  }
  return order.map((area) => ({ area, ideas: groups.get(area) ?? [] }));
}

function IdeaRow({ idea, onSend }: { idea: Idea; onSend: (text: string) => void }) {
  const Icon = ideaIcon(idea.area);
  return (
    <button
      type="button"
      onClick={() => onSend(idea.text)}
      className="group flex w-full items-center gap-4 rounded-2xl px-3 py-3 text-start transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
    >
      <span
        aria-hidden="true"
        className="grid size-10 shrink-0 place-items-center rounded-2xl bg-muted"
      >
        <Icon size={19} strokeWidth={1.75} className="text-muted-foreground" />
      </span>
      <span className={cn("min-w-0 flex-1", MUSE_TYPE.cardTitle)}>{idea.text}</span>
      <ArrowRight
        size={16}
        strokeWidth={1.75}
        aria-hidden="true"
        className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
      />
    </button>
  );
}

function IdeasSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-hidden="true">
      {[0, 1, 2, 3].map((key) => (
        <div key={key} className="flex items-center gap-4 px-3 py-3">
          <Skeleton className="size-10 shrink-0 rounded-2xl" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ))}
    </div>
  );
}

/**
 * F5 · Ideas. Things the Muse could start now, grouped by area (Meta Muse's Ideas page
 * is the reference: a big plain title, a first-person subtitle, colorful icon rows
 * under sentence-case group headings). Tapping a row starts a Conversation with it.
 */
export function IdeasScreen({
  botId,
  onSendIdea,
}: {
  botId: string;
  onSendIdea: (text: string) => void;
}) {
  const { t } = useLingui();
  const [ideas, setIdeas] = useState<Idea[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    setIdeas(null);
    void rpc.ideas
      .list({ botId })
      .then((list) => {
        if (current === generation.current) setIdeas(list);
      })
      .catch(() => {
        if (current === generation.current) setIdeas([]);
      });
    return () => {
      generation.current += 1;
    };
  }, [botId]);

  async function handleRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      setIdeas(await rpc.ideas.refresh({ botId }));
    } finally {
      setRefreshing(false);
    }
  }

  const groups = useMemo(() => groupByArea(ideas ?? []), [ideas]);

  return (
    <MuseScreen
      header={
        <ScreenHeader
          title={t`Ideas`}
          actions={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t`Refresh ideas`}
              title={t`Refresh ideas`}
              disabled={refreshing || ideas === null}
              onClick={() => void handleRefresh()}
            >
              <RefreshCw
                size={14}
                strokeWidth={1.75}
                className={refreshing ? "animate-spin" : ""}
              />
            </Button>
          }
        />
      }
    >
      <MuseColumn className="flex min-h-full flex-col pt-8 pb-10">
        <div className="pb-8">
          <h1 className={MUSE_TYPE.pageTitle}>
            <Trans>Ideas</Trans>
          </h1>
          <p className={cn("mt-1.5", MUSE_TYPE.pageSubtitle)}>
            <Trans>I'm always looking for new ways to help. My favourite ideas show up here.</Trans>
          </p>
        </div>

        {ideas === null ? (
          <IdeasSkeleton />
        ) : ideas.length === 0 ? (
          <EmptyState headline={t`Nothing to suggest yet`}>
            <Trans>I'll show ideas here as I learn what's useful to you.</Trans>
          </EmptyState>
        ) : (
          <div className="flex flex-col gap-8">
            {groups.map((group) => (
              <div key={group.area} className="flex flex-col gap-1">
                <h2 className="px-3 pb-2 text-[18px] font-semibold text-foreground">
                  {areaLabel(group.area)}
                </h2>
                <div className="flex flex-col">
                  {group.ideas.map((idea) => (
                    <IdeaRow key={idea.id} idea={idea} onSend={onSendIdea} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </MuseColumn>
    </MuseScreen>
  );
}
