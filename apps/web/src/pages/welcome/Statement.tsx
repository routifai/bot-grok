import { useLingui } from "@lingui/react/macro";
import { type RefObject, useRef, useState } from "react";
import { GUTTER } from "./Cta";
import { usePrefersReducedMotion, useScrollEffect } from "./hooks";

/** One sentence whose words light up as it scrolls into the middle of the screen. */
export function Statement({ scrollRef }: { scrollRef: RefObject<HTMLElement | null> }) {
  const { t } = useLingui();
  const reduce = usePrefersReducedMotion();
  const words =
    t`One conversation that never ends. It remembers, works on its own computer, and asks before anything it can't undo.`.split(
      " ",
    );
  const ref = useRef<HTMLParagraphElement>(null);
  const [lit, setLit] = useState(0);

  useScrollEffect(scrollRef, () => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const h = window.innerHeight;
    const p = Math.min(1, Math.max(0, (h * 0.85 - box.top) / (box.height + h * 0.45)));
    setLit(Math.round(p * words.length));
  });

  return (
    <section
      aria-label={t`What Nova is`}
      className={`relative z-1 mx-auto max-w-[1000px] pt-[22vh] pb-[18vh] text-center ${GUTTER}`}
    >
      <p
        ref={ref}
        className="welcome-display m-0 text-[clamp(28px,3.4vw,46px)] leading-[1.18] tracking-[-0.025em]"
      >
        {words.map((w, i) => (
          <span key={i}>
            {i > 0 ? " " : null}
            <span
              className={`transition-colors duration-250 ${reduce || i < lit ? "text-welcome-night-ink" : "text-welcome-night-ink/16"}`}
            >
              {w}
            </span>
          </span>
        ))}
      </p>
    </section>
  );
}
