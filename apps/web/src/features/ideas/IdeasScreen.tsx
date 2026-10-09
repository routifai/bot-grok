import { Trans, useLingui } from "@lingui/react/macro";
import type { Idea } from "@nova/contracts";
import { cn, Skeleton } from "@nova/ui-web";
import { useEffect, useMemo, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import { IdeasGlyph } from "../../pages/muse/chrome/NovaGlyphs";
import { NovaTile, type TileTone } from "../../pages/muse/chrome/NovaTile";
import {
  EmptyState,
  MuseScreen,
  MuseWideCenter,
  ScreenHeader,
  ScreenHero,
} from "../../pages/muse/ui";
import { areaLabel, ideaIcon } from "./areaIcon";

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

/** A tile color per area, stable for the area's name. */
const AREA_TONES: TileTone[] = ["yellow", "teal", "purple", "blue", "green", "orange", "indigo"];

function areaTone(area: string): TileTone {
  let hash = 0;
  for (const char of area) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AREA_TONES[hash % AREA_TONES.length] ?? "yellow";
}

const ROW_ACTION =
  "h-7 shrink-0 rounded-full px-3 text-[12.5px] font-medium transition-[filter,background-color] focus-visible:outline-2 focus-visible:outline-ring";

/** One Idea as a grouped-list row: its area's tile, the Idea and its detail, Dismiss and Do it. */
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
      className="nova-row grid min-h-[52px] grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-x-3 px-3 py-2.5 motion-safe:animate-in motion-safe:fade-in motion-safe:fill-mode-both motion-safe:duration-300"
      style={{ animationDelay: `${Math.min(index, 8) * 40}ms` }}
    >
      <NovaTile tone={areaTone(idea.area)} size={28}>
        <Icon strokeWidth={2.4} />
      </NovaTile>
      <div className="min-w-0">
        <p className="text-[14px] leading-[1.3] tracking-[-0.15px] text-foreground" dir="auto">
          {idea.text}
        </p>
        {detail ? (
          <p className="mt-0.5 line-clamp-2 text-[12px] leading-[1.35] text-ink-3" dir="auto">
            {detail}
          </p>
        ) : showArea ? (
          <p className="mt-0.5 text-[12px] text-ink-3">{areaLabel(idea.area)}</p>
        ) : null}
      </div>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          className={cn(ROW_ACTION, "text-ink-2 hover:bg-selection")}
          onClick={() => onDismiss(idea.id)}
        >
          <Trans>Dismiss</Trans>
        </button>
        <button
          type="button"
          className={cn(ROW_ACTION, "bg-tint text-white hover:brightness-110")}
          onClick={() => onSend(idea)}
        >
          <Trans>Do it</Trans>
        </button>
      </div>
    </li>
  );
}

function IdeasSkeleton() {
  return (
    <div className="nova-group flex flex-col" aria-hidden="true">
      {[0, 1, 2, 3].map((key) => (
        <div key={key} className="flex items-center gap-3 px-3 py-3">
          <Skeleton className="size-7 shrink-0 rounded-[30%]" />
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
    <MuseScreen header={<ScreenHeader title={t`Ideas`} dragRegion />}>
      <MuseWideCenter className="min-h-full">
        <ScreenHero
          tile={
            <NovaTile tone="orange" size={44}>
              <IdeasGlyph />
            </NovaTile>
          }
          title={<Trans>Ideas</Trans>}
          subtitle={
            <Trans>I'm always looking for new ways to help. My favourite ideas show up here.</Trans>
          }
        />

        {ideas === null ? (
          <IdeasSkeleton />
        ) : visible.length === 0 ? (
          <EmptyState illustration="light-bulb" headline={t`Nothing to suggest yet`}>
            <Trans>I'll show ideas here as I learn what's useful to you.</Trans>
          </EmptyState>
        ) : grouped ? (
          <div className="flex flex-col gap-4">
            {groups.map((group) => (
              <section key={group.area} className="flex flex-col gap-1.5">
                <h2 className="px-1.5 text-[13px] font-semibold text-foreground">
                  {areaLabel(group.area)}
                </h2>
                <ul className="nova-group">
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
          <ul className="nova-group">
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
      </MuseWideCenter>
    </MuseScreen>
  );
}
