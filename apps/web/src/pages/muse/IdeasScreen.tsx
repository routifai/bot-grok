import type { Idea } from "@aiden/contracts";
import { Button, cn, Skeleton } from "@aiden/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useMemo, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import { areaLabel, ideaIcon } from "./ideas/areaIcon";
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
  onDismiss,
}: {
  idea: Idea;
  index: number;
  showArea: boolean;
  onSend: (idea: Idea) => void;
  onDismiss: (id: string) => void;
}) {
  const detail = idea.detail;
  const Icon = ideaIcon(idea);
  return (
    <li
      className="flex items-start gap-4 py-4 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:fill-mode-both motion-safe:duration-300"
      style={{ animationDelay: `${Math.min(index, 8) * 40}ms` }}
    >
      <span
        aria-hidden="true"
        className="mt-0.5 grid size-10 shrink-0 place-items-center rounded-xl bg-muted text-foreground"
      >
        <Icon size={19} strokeWidth={1.75} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[16px] font-medium leading-snug text-foreground">{idea.text}</p>
        {detail ? (
          <p className="mt-1 text-[15px] leading-[1.5] text-muted-foreground">{detail}</p>
        ) : showArea ? (
          <p className="mt-0.5 text-[13.5px] text-muted-foreground">{areaLabel(idea.area)}</p>
        ) : null}
        <div className="mt-3 flex items-center gap-1.5">
          <Button size="sm" variant="outline" className="rounded-full" onClick={() => onSend(idea)}>
            <Trans>Do it</Trans>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="rounded-full text-muted-foreground"
            onClick={() => onDismiss(idea.id)}
          >
            <Trans>Dismiss</Trans>
          </Button>
        </div>
      </div>
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

const dismissedKey = (botId: string) => `nova.ideas.dismissed.${botId}`;

function readDismissed(botId: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(dismissedKey(botId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

/**
 * F5 · Ideas. Things the Muse could start now (the reference design is
 * a plain title, a first-person subtitle, and quiet icon rows). Rows group under their
 * area only when every group gathers more than one idea; otherwise the area rides along
 * as a muted line. "Do it" starts a Conversation with the Idea; "Dismiss" hides it on this device.
 */
// Ideas the Muse found in the background ("suggested") are accepted and dismissed on the
// server, which sends the idea's message into the Conversation itself.
const isSuggested = (idea: Idea) => idea.area === "suggested";

export function IdeasScreen({
  botId,
  onSendIdea,
  onOpenConversation,
}: {
  botId: string;
  onSendIdea: (text: string) => void;
  onOpenConversation?: () => void;
}) {
  const { t } = useLingui();
  const [ideas, setIdeas] = useState<Idea[] | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(() => readDismissed(botId));
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    setIdeas(null);
    setDismissed(readDismissed(botId));
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

  const visible = useMemo(
    () => (ideas ?? []).filter((idea) => !dismissed.has(idea.id)),
    [ideas, dismissed],
  );
  const groups = useMemo(() => groupByArea(visible), [visible]);

  function act(idea: Idea) {
    if (!isSuggested(idea)) {
      onSendIdea(idea.text);
      return;
    }
    hide(idea.id);
    onOpenConversation?.();
    void rpc.ideas.accept({ botId, ideaId: idea.id }).catch(() => undefined);
  }

  function dismiss(id: string) {
    const idea = ideas?.find((candidate) => candidate.id === id);
    if (idea && isSuggested(idea))
      void rpc.ideas.dismiss({ botId, ideaId: id }).catch(() => undefined);
    hide(id);
  }

  function hide(id: string) {
    const next = new Set(dismissed).add(id);
    setDismissed(next);
    try {
      window.localStorage.setItem(dismissedKey(botId), JSON.stringify([...next]));
    } catch {
      // Dismissal then lasts until reload.
    }
  }
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
        ) : visible.length === 0 ? (
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
                <ul className="flex flex-col divide-y divide-border/60">
                  {group.ideas.map((idea) => (
                    <IdeaRow
                      key={idea.id}
                      idea={idea}
                      index={index++}
                      showArea={false}
                      onSend={act}
                      onDismiss={dismiss}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        ) : (
          <ul className="flex flex-col divide-y divide-border/60">
            {visible.map((idea, i) => (
              <IdeaRow
                key={idea.id}
                idea={idea}
                index={i}
                showArea
                onSend={act}
                onDismiss={dismiss}
              />
            ))}
          </ul>
        )}
      </MuseColumn>
    </MuseScreen>
  );
}
