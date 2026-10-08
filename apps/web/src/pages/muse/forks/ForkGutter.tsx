import type { MessageFork, ThreadMessage } from "@aiden/contracts";
import { cn, Popover, PopoverContent, PopoverTrigger } from "@aiden/ui-web";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { type CSSProperties, type RefObject, useEffect, useMemo, useState } from "react";
import {
  FORK_TONE_CLASS,
  type ForkRow,
  type ForkStatus,
  type GutterGroup,
  gutterLayout,
  shownForks,
  unloadedForkCount,
} from "./forkModel";

/** Marks never sit closer than this to the strip's ends. */
const EDGE_PX = 18;
/** The smallest hit area of a mark. */
const HIT_PX = 20;

type View = { top: number; height: number };

/**
 * Where the forks are, at a glance (ADR 0010): a thin rail on the Conversation's end edge. A
 * message with forks is a mark at its place in the scrolled content; marks closer than 16px merge
 * into one count capsule whose popover lists them. One open fork is a dot in its color (pulsing
 * while Nova works in it), a finished one a short grey tick; a group with an open fork gets a
 * ring in that fork's color. Forks whose message is in history not loaded yet show as "↑ N" at the
 * top, which loads it. A band shows what is in view. Nothing renders while no fork is on the rail.
 */
export function ForkGutter({
  scrollRef,
  messages,
  forks,
  onJump,
  onLoadEarlier,
}: {
  scrollRef: RefObject<HTMLElement | null>;
  messages: readonly ThreadMessage[];
  /** Every fork of the Conversation (loaded or not), to count those in unloaded history. */
  forks: readonly ForkRow[];
  onJump: (messageId: string) => void;
  /** Loads older history; the rail then scrolls to the top. */
  onLoadEarlier?: () => void | Promise<void>;
}) {
  const { t } = useLingui();
  const forksById = useMemo(() => {
    const map = new Map<string, readonly MessageFork[]>();
    for (const message of messages) {
      const shown = shownForks(message.forks);
      if (shown.length) map.set(message.id, shown);
    }
    return map;
  }, [messages]);
  const unloaded = useMemo(
    () => unloadedForkCount(forks, new Set(messages.map((message) => message.id))),
    [forks, messages],
  );
  const [groups, setGroups] = useState<GutterGroup[]>([]);
  const [view, setView] = useState<View>({ top: 0, height: 1 });

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const readView = (): View => {
      const total = Math.max(element.scrollHeight, element.clientHeight, 1);
      return {
        top: Math.min(1, Math.max(0, element.scrollTop / total)),
        height: Math.min(1, Math.max(0, element.clientHeight / total)),
      };
    };
    const sameView = (a: View, b: View) => a.top === b.top && a.height === b.height;
    let frame = 0;
    let scrollFrame = 0;
    const measure = () => {
      frame = 0;
      if (forksById.size === 0) {
        setGroups((current) => (current.length ? [] : current));
        return;
      }
      const box = element.getBoundingClientRect();
      const rows = [...element.querySelectorAll<HTMLElement>("[data-message-id]")].flatMap(
        (row) => {
          const messageId = row.dataset.messageId;
          if (!messageId || !forksById.has(messageId)) return [];
          const rect = row.getBoundingClientRect();
          return [{ messageId, top: rect.top - box.top + element.scrollTop, height: rect.height }];
        },
      );
      const layout = gutterLayout({
        rows,
        forksById,
        scrollHeight: element.scrollHeight,
        scrollTop: element.scrollTop,
        clientHeight: element.clientHeight,
        railHeight: element.clientHeight - 2 * EDGE_PX,
      });
      setGroups(layout.groups);
      setView((current) => (sameView(current, layout.view) ? current : layout.view));
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };
    // Scrolling moves only the band: marks are regrouped on resize and message changes.
    const onScroll = () => {
      if (scrollFrame) return;
      scrollFrame = window.requestAnimationFrame(() => {
        scrollFrame = 0;
        const next = readView();
        setView((current) => (sameView(current, next) ? current : next));
      });
    };
    measure();
    element.addEventListener("scroll", onScroll, { passive: true });
    const resize = new ResizeObserver(schedule);
    resize.observe(element);
    for (const child of element.children) resize.observe(child);
    return () => {
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(scrollFrame);
      element.removeEventListener("scroll", onScroll);
      resize.disconnect();
    };
  }, [scrollRef, forksById]);

  if (!groups.length && unloaded === 0) return null;
  const statusLabel: Record<ForkStatus, string> = {
    live: t`Nova is working`,
    open: t`Open`,
    added: t`Finished`,
    archived: t`Finished`,
  };
  return (
    <fieldset
      aria-label={t`Forks`}
      data-testid="fork-gutter"
      className="relative m-0 w-[34px] min-w-0 shrink-0 border-0 border-s border-line p-0 sm:w-[52px]"
    >
      {unloaded > 0 ? (
        <button
          type="button"
          data-testid="fork-gutter-more"
          aria-label={plural(unloaded, {
            one: "# fork in earlier history",
            other: "# forks in earlier history",
          })}
          onClick={() => {
            void Promise.resolve(onLoadEarlier?.()).then(() =>
              scrollRef.current?.scrollTo({ top: 0 }),
            );
          }}
          className="absolute start-1/2 top-0.5 z-10 -translate-x-1/2 whitespace-nowrap rounded-full border border-line bg-card px-1.5 text-[10px] tabular-nums text-ink-2 hover:bg-selection focus-visible:outline-2 focus-visible:outline-ring rtl:translate-x-1/2"
        >
          ↑ {unloaded}
        </button>
      ) : null}
      <div className="absolute inset-x-0" style={{ top: EDGE_PX, bottom: EDGE_PX }}>
        <span
          aria-hidden="true"
          className="absolute inset-x-1.5 rounded-lg bg-selection transition-[top,height] duration-150 motion-reduce:transition-none sm:inset-x-2"
          style={{ top: `${view.top * 100}%`, height: `${view.height * 100}%` }}
        />
        <span
          aria-hidden="true"
          className="absolute inset-y-0 start-1/2 w-0.5 -translate-x-1/2 rounded-full bg-line rtl:translate-x-1/2"
        />
        {groups.map((group) => {
          const markClass =
            "absolute start-1/2 grid min-h-5 min-w-5 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full focus-visible:outline-2 focus-visible:outline-ring rtl:translate-x-1/2";
          const style = { top: group.y, minWidth: HIT_PX, minHeight: HIT_PX };
          const ring = group.live ? (
            <span
              className={cn(
                "absolute -inset-[5px] rounded-full border-2 animate-[rkPulse_1.6s_ease-in-out_infinite] motion-reduce:animate-none",
                FORK_TONE_CLASS[group.tone].border,
              )}
            />
          ) : null;
          if (group.count === 1) {
            const [only] = group.forks;
            return (
              <button
                key={group.messageId}
                type="button"
                onClick={() => onJump(group.messageId)}
                aria-label={only?.title || plural(1, { one: "# fork", other: "# forks" })}
                className={cn(markClass, "group/mark")}
                style={style}
              >
                {group.open ? (
                  <span
                    aria-hidden="true"
                    className={cn(
                      "relative block size-3 rounded-full transition-transform group-hover/mark:scale-125 motion-reduce:transition-none",
                      FORK_TONE_CLASS[group.tone].bg,
                    )}
                  >
                    {ring}
                  </span>
                ) : (
                  <span
                    aria-hidden="true"
                    className="block h-[3px] w-3 rounded-sm bg-ink-3 transition-transform group-hover/mark:scale-x-125 motion-reduce:transition-none"
                  />
                )}
              </button>
            );
          }
          return (
            <GroupCapsule
              key={group.messageId}
              group={group}
              markClass={markClass}
              style={style}
              statusLabel={statusLabel}
              onJump={onJump}
            />
          );
        })}
      </div>
    </fieldset>
  );
}

function GroupCapsule({
  group,
  markClass,
  style,
  statusLabel,
  onJump,
}: {
  group: GutterGroup;
  markClass: string;
  style: CSSProperties;
  statusLabel: Record<ForkStatus, string>;
  onJump: (messageId: string) => void;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={plural(group.count, { one: "# fork", other: "# forks" })}
        className={cn(markClass, "data-[popup-open]:z-10")}
        style={style}
      >
        <span
          aria-hidden="true"
          className={cn(
            "relative grid h-5 min-w-5 place-items-center rounded-full border-2 border-card px-[5px] text-[11px] font-bold tabular-nums",
            group.open ? "bg-foreground text-background" : "bg-line text-foreground",
          )}
        >
          {group.count}
          {group.open ? (
            <span
              className={cn(
                "absolute -inset-1 rounded-full border-2",
                FORK_TONE_CLASS[group.tone].border,
                group.live &&
                  "animate-[rkPulse_1.6s_ease-in-out_infinite] motion-reduce:animate-none",
              )}
            />
          ) : null}
        </span>
      </PopoverTrigger>
      <PopoverContent
        side="inline-start"
        align="center"
        sideOffset={8}
        aria-label={t`Forks`}
        className="w-[min(250px,calc(100vw-2rem))] gap-0 rounded-xl border border-line bg-card p-1.5 shadow-float ring-0"
      >
        <ul className="m-0 flex list-none flex-col p-0">
          {group.forks.map((fork) => (
            <li key={fork.chatId}>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onJump(fork.messageId);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-start text-[13px] hover:bg-selection focus-visible:bg-selection focus-visible:outline-none"
              >
                <span
                  aria-hidden="true"
                  className={cn("size-[9px] shrink-0 rounded-full", FORK_TONE_CLASS[fork.tone].bg)}
                />
                <span className="min-w-0 flex-1 truncate" dir="auto">
                  {fork.title}
                </span>
                <span className="shrink-0 text-[11px] text-ink-3">{statusLabel[fork.status]}</span>
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
