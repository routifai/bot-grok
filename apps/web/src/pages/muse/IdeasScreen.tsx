import type { Idea } from "@aiden/contracts";
import { cn, Skeleton } from "@aiden/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useMemo, useRef, useState } from "react";
import { illustrationUrl } from "../../lib/illustrations";
import { rpc } from "../../lib/rpc";
import { areaLabel, ideaIllustration } from "./ideas/areaIcon";
import { EmptyState, MUSE_TYPE, MuseColumn, MuseScreen } from "./ui";

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

/** Headings only help when they gather things: a page of one-idea groups reads as noise. */
function worthGrouping(groups: { ideas: Idea[] }[]): boolean {
  return groups.length > 1 && groups.length <= 4 && groups.every((group) => group.ideas.length > 1);
}

function IdeaRow({
  idea,
  index,
  showArea,
  onSend,
}: {
  idea: Idea;
  index: number;
  showArea: boolean;
  onSend: (text: string) => void;
}) {
  const detail = idea.detail;
  return (
    <li
      className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:fill-mode-both motion-safe:duration-300"
      style={{ animationDelay: `${Math.min(index, 8) * 40}ms` }}
    >
      <button
        type="button"
        onClick={() => onSend(idea.text)}
        className="-mx-4 flex w-[calc(100%+2rem)] items-start gap-4 rounded-2xl px-4 py-3.5 text-start transition-colors hover:bg-accent/60 focus-visible:outline-2 focus-visible:outline-ring"
      >
        <img
          src={illustrationUrl(ideaIllustration(idea))}
          alt=""
          loading="lazy"
          className="mt-0.5 size-9 shrink-0"
        />
        <span className="min-w-0 flex-1">
          <span className="block text-[16px] font-medium leading-snug text-foreground">
            {idea.text}
          </span>
          {detail ? (
            <span className="mt-1 block text-[15px] leading-[1.5] text-muted-foreground">
              {detail}
            </span>
          ) : showArea ? (
            <span className="mt-0.5 block text-[13.5px] text-muted-foreground">
              {areaLabel(idea.area)}
            </span>
          ) : null}
        </span>
      </button>
    </li>
  );
}

function IdeasSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-hidden="true">
      {[0, 1, 2, 3].map((key) => (
        <div key={key} className="flex items-center gap-4 py-3">
          <Skeleton className="size-10 shrink-0 rounded-xl" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-24" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * F5 · Ideas. Things the Muse could start now (Meta Muse's Ideas page is the reference:
 * a plain title, a first-person subtitle, and quiet icon rows). Rows group under their
 * area only when every group gathers more than one idea; otherwise the area rides along
 * as a muted line. Tapping a row starts a Conversation with it.
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

  const groups = useMemo(() => groupByArea(ideas ?? []), [ideas]);
  const grouped = worthGrouping(groups);
  let index = 0;

  return (
    <MuseScreen>
      <MuseColumn className="flex min-h-full flex-col pt-14 pb-12">
        <header className="pb-8">
          <h1 className={MUSE_TYPE.pageTitle}>
            <Trans>Ideas</Trans>
          </h1>
          <p className={cn("mt-2", MUSE_TYPE.pageSubtitle)}>
            <Trans>I'm always looking for new ways to help. My favourite ideas show up here.</Trans>
          </p>
        </header>

        {ideas === null ? (
          <IdeasSkeleton />
        ) : ideas.length === 0 ? (
          <EmptyState face illustration="light-bulb" headline={t`Nothing to suggest yet`}>
            <Trans>I'll show ideas here as I learn what's useful to you.</Trans>
          </EmptyState>
        ) : grouped ? (
          <div className="flex flex-col gap-8">
            {groups.map((group) => (
              <section key={group.area}>
                <h2 className="pb-1 text-[17px] font-semibold text-foreground">
                  {areaLabel(group.area)}
                </h2>
                <ul className="flex flex-col">
                  {group.ideas.map((idea) => (
                    <IdeaRow
                      key={idea.id}
                      idea={idea}
                      index={index++}
                      showArea={false}
                      onSend={onSendIdea}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        ) : (
          <ul className="flex flex-col gap-1">
            {(ideas ?? []).map((idea, i) => (
              <IdeaRow key={idea.id} idea={idea} index={i} showArea onSend={onSendIdea} />
            ))}
          </ul>
        )}
      </MuseColumn>
    </MuseScreen>
  );
}
