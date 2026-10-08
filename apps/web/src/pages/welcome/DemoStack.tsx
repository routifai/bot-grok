import { Trans } from "@lingui/react/macro";
import { type RefObject, useRef, useState } from "react";
import { GUTTER } from "./Cta";
import { AskCard, BranchCard, CreateCard, LearnCard, RememberCard, WorkCard } from "./DemoCards";
import { useScrollEffect } from "./hooks";

/** The light sheet: six sticky dark cards; the one in front plays its demo, the rest reset. */
export function DemoStack({ scrollRef }: { scrollRef: RefObject<HTMLElement | null> }) {
  const cards = useRef<(HTMLElement | null)[]>([]);
  const [front, setFront] = useState<number | null>(null);

  useScrollEffect(scrollRef, () => {
    // The front card: the last one whose top has reached its sticky position.
    let next: number | null = null;
    cards.current.forEach((c, i) => {
      if (!c) return;
      if (c.getBoundingClientRect().top <= Number.parseFloat(getComputedStyle(c).top) + 2) next = i;
    });
    const first = cards.current[0];
    if (next === null && first && first.getBoundingClientRect().top < window.innerHeight * 0.6) {
      next = 0;
    }
    setFront(next);
  });

  const ref = (i: number) => (el: HTMLElement | null) => {
    cards.current[i] = el;
  };

  return (
    <div className="relative z-2 rounded-t-[28px] bg-welcome-sheet pt-[90px] pb-10">
      <div className={`mx-auto mb-10 max-w-[1160px] ${GUTTER}`}>
        <h2 className="welcome-display text-[clamp(36px,4.6vw,64px)] leading-[1.02] font-normal tracking-[-0.035em] text-welcome-ink">
          <Trans>See it work.</Trans>
        </h2>
      </div>
      <div className="mx-auto max-w-[1240px] px-[clamp(12px,2vw,24px)]">
        <RememberCard active={front === 0} cardRef={ref(0)} />
        <BranchCard active={front === 1} cardRef={ref(1)} />
        <WorkCard active={front === 2} cardRef={ref(2)} />
        <LearnCard active={front === 3} cardRef={ref(3)} />
        <CreateCard active={front === 4} cardRef={ref(4)} />
        <AskCard active={front === 5} cardRef={ref(5)} />
      </div>
    </div>
  );
}
