import type { MessageFork, ThreadMessage } from "@aiden/contracts";
import { cn } from "@aiden/ui-web";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { type RefObject, useEffect, useMemo, useState } from "react";
import { FORK_TONE_CLASS, type GutterLayout, gutterLayout } from "./forkModel";

/** Dots never sit closer than this to the strip's ends. */
const EDGE_PX = 18;
/** The smallest hit area of a dot. */
const HIT_PX = 20;

/**
 * Where the forks are, at a glance (ADR 0010): a thin strip on the Conversation's end edge with
 * one dot per message that has forks, at that message's place in the scrolled content, sized by
 * how many and colored by its first open fork (pulsing while Nova works in one, dashed grey once
 * all are done), over a band for what is in view. A dot scrolls to its message. Nothing renders
 * while no loaded message has forks.
 */
export function ForkGutter({
  scrollRef,
  messages,
  onJump,
}: {
  scrollRef: RefObject<HTMLElement | null>;
  messages: readonly ThreadMessage[];
  onJump: (messageId: string) => void;
}) {
  const { t } = useLingui();
  const forksById = useMemo(() => {
    const map = new Map<string, readonly MessageFork[]>();
    for (const message of messages) {
      if (message.forks?.length) map.set(message.id, message.forks);
    }
    return map;
  }, [messages]);
  const [layout, setLayout] = useState<GutterLayout | null>(null);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || forksById.size === 0) {
      setLayout(null);
      return;
    }
    let frame = 0;
    const measure = () => {
      frame = 0;
      const box = element.getBoundingClientRect();
      const rows = [...element.querySelectorAll<HTMLElement>("[data-message-id]")].flatMap(
        (row) => {
          const messageId = row.dataset.messageId;
          if (!messageId || !forksById.has(messageId)) return [];
          const rect = row.getBoundingClientRect();
          return [{ messageId, top: rect.top - box.top + element.scrollTop, height: rect.height }];
        },
      );
      setLayout(
        gutterLayout({
          rows,
          forksById,
          scrollHeight: element.scrollHeight,
          scrollTop: element.scrollTop,
          clientHeight: element.clientHeight,
        }),
      );
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };
    measure();
    element.addEventListener("scroll", schedule, { passive: true });
    const resize = new ResizeObserver(schedule);
    resize.observe(element);
    for (const child of element.children) resize.observe(child);
    return () => {
      window.cancelAnimationFrame(frame);
      element.removeEventListener("scroll", schedule);
      resize.disconnect();
    };
  }, [scrollRef, forksById]);

  if (!layout?.marks.length) return null;
  return (
    <fieldset
      aria-label={t`Forks`}
      data-testid="fork-gutter"
      className="relative m-0 w-[34px] min-w-0 shrink-0 border-0 border-s border-line p-0 sm:w-[52px]"
    >
      <div className="absolute inset-x-0" style={{ top: EDGE_PX, bottom: EDGE_PX }}>
        <span
          aria-hidden="true"
          className="absolute inset-x-1.5 rounded-lg bg-selection transition-[top,height] duration-150 motion-reduce:transition-none sm:inset-x-2"
          style={{ top: `${layout.view.top * 100}%`, height: `${layout.view.height * 100}%` }}
        />
        <span
          aria-hidden="true"
          className="absolute inset-y-0 start-1/2 w-0.5 -translate-x-1/2 rounded-full bg-line rtl:translate-x-1/2"
        />
        {layout.marks.map((mark) => (
          <button
            key={mark.messageId}
            type="button"
            onClick={() => onJump(mark.messageId)}
            aria-label={plural(mark.count, { one: "# fork", other: "# forks" })}
            className="group/mark absolute start-1/2 grid -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full focus-visible:outline-2 focus-visible:outline-ring rtl:translate-x-1/2"
            style={{
              top: `${mark.at * 100}%`,
              width: Math.max(mark.size, HIT_PX),
              height: Math.max(mark.size, HIT_PX),
            }}
          >
            <span
              aria-hidden="true"
              className={cn(
                "relative block rounded-full border-2 transition-transform group-hover/mark:scale-125 motion-reduce:transition-none",
                mark.done
                  ? "border-dashed border-ink-3 bg-card"
                  : cn("border-card", FORK_TONE_CLASS[mark.tone].bg),
              )}
              style={{ width: mark.size, height: mark.size }}
            >
              {mark.live ? (
                <span
                  className={cn(
                    "absolute -inset-[5px] rounded-full border-2 animate-[rkPulse_1.6s_ease-in-out_infinite] motion-reduce:animate-none",
                    FORK_TONE_CLASS[mark.tone].border,
                  )}
                />
              ) : null}
            </span>
          </button>
        ))}
      </div>
    </fieldset>
  );
}
