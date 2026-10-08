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
    // The front card: the last one that has risen into the top part of the page, where the
    // cards stack. Not compared with the computed sticky `top`: under browser zoom that value
    // and the measured position disagree, and no card would ever count as arrived.
    const scroller = scrollRef.current?.getBoundingClientRect();
    if (!scroller) return;
    const line = scroller.top + scroller.height * 0.45;
    let next: number | null = null;
    cards.current.forEach((c, i) => {
      if (c && c.getBoundingClientRect().top <= line) next = i;
    });
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
