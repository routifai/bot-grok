import type { ReactNode, Ref } from "react";

/** The fade-and-rise every demo beat uses. */
export function fx(on: boolean): string {
  return `transition-[opacity,translate] duration-500 ease-[ease] ${on ? "translate-y-0 opacity-100" : "translate-y-[10px] opacity-0"}`;
}

/** Same, a little smaller, for the beats inside the computer's screen. */
export function fx2(on: boolean, offClass = "opacity-0"): string {
  return `transition-[opacity,translate] duration-[450ms] ${on ? "translate-y-0 opacity-100" : `translate-y-1.5 ${offClass}`}`;
}

export const BUBBLE =
  "max-w-[85%] rounded-2xl bg-welcome-night-bubble px-3.5 py-2.5 text-[15px] leading-[1.45] text-welcome-night-ink";
export const BUBBLE_YOU = "self-end bg-welcome-me! text-welcome-paper!";

/** Lays a demo's beats out centred in the demo column. */
export function DemoColumn({ children }: { children: ReactNode }) {
  return (
    <div className="absolute inset-0 m-auto flex h-max max-w-[520px] flex-col gap-2.5">
      {children}
    </div>
  );
}

/** One sticky dark card: eyebrow, big word, one line, and its demo on the right. */
export function DemoCard({
  cardRef,
  wide,
  eyebrow,
  title,
  body,
  children,
}: {
  cardRef: Ref<HTMLElement>;
  wide?: boolean;
  eyebrow: ReactNode;
  title: ReactNode;
  body: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      ref={cardRef}
      className={`welcome-card sticky mb-7 grid grid-cols-1 gap-[18px] overflow-hidden rounded-[26px] border border-welcome-night-glow/28 bg-welcome-pc px-[clamp(22px,4vw,56px)] pt-5 pb-10 text-welcome-night-ink min-[861px]:min-h-[min(560px,78vh)] min-[861px]:gap-6 ${wide ? "min-[861px]:grid-cols-[.8fr_1.4fr]" : "min-[861px]:grid-cols-[1fr_1.05fr]"}`}
    >
      <p className="col-span-full m-0 font-mono text-[13px] leading-5 tracking-[0.12em] text-welcome-night-glow-ink">
        {eyebrow}
      </p>
      <div className="self-center">
        <h3 className="welcome-display mb-[18px] text-[clamp(52px,7vw,104px)] leading-none font-normal tracking-[-0.04em]">
          {title}
        </h3>
        <p className="m-0 max-w-[30ch] text-[clamp(17px,1.5vw,21px)] leading-[1.45] text-welcome-night-body">
          {body}
        </p>
      </div>
      <div className="relative min-h-[280px] self-center min-[861px]:min-h-[360px]">{children}</div>
    </section>
  );
}
