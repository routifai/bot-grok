import { useRef } from "react";
import { Link } from "react-router-dom";
import { NovaMark } from "./Brand";
import { GUTTER } from "./Cta";
import { Grain } from "./Grain";
import { Stars } from "./Stars";

/** Shared field/button looks for pages that wear the signed-out welcome surface (night). */
export const welcomeFieldClass =
  "mt-2 h-12 rounded-xl border-welcome-night-line/16 bg-welcome-night-bubble px-4 text-base text-welcome-night-ink placeholder:text-welcome-night-ink-3 focus-visible:border-welcome-night-glow focus-visible:ring-welcome-night-glow/30 md:text-base dark:border-welcome-night-line/16 dark:bg-welcome-night-bubble";
export const welcomeSubmitClass =
  "mt-4 h-12 w-full rounded-full bg-welcome-night-ink text-[15px] font-semibold text-welcome-night hover:bg-welcome-paper focus-visible:ring-welcome-night-glow/60";

export const welcomeHeadingClass =
  "welcome-display text-center text-[clamp(34px,5vw,44px)] font-normal leading-[1.02] tracking-[-0.035em] text-balance text-welcome-night-ink";

/** Same night surface as the signed-out welcome page (`welcome-*` tokens), whatever the theme. */
export function WelcomeFrame({
  title,
  onSubmit,
  width = "w-[400px]",
  children,
}: {
  title?: React.ReactNode;
  onSubmit?: (event: React.FormEvent) => void;
  width?: string;
  children: React.ReactNode;
}) {
  const body = (
    <>
      {title ? (
        <h1 aria-live="polite" className={`mb-8 ${welcomeHeadingClass}`}>
          {title}
        </h1>
      ) : null}
      {children}
    </>
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyClass = `flex ${width} max-w-full flex-col items-center`;
  return (
    <div
      ref={rootRef}
      className="relative isolate flex min-h-full flex-col bg-welcome-night text-welcome-night-ink antialiased [color-scheme:dark]"
      data-nova-surface="welcome"
    >
      <Stars scrollRef={rootRef} />
      <Grain />
      <header className={`relative z-1 flex w-full items-center py-[22px] ${GUTTER}`}>
        <Link
          to="/"
          className="rounded-md focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-welcome-night-glow"
        >
          <NovaMark />
        </Link>
      </header>
      <main className="relative z-1 flex flex-1 items-center justify-center px-4 pb-[12vh]">
        {onSubmit ? (
          <form onSubmit={onSubmit} className={bodyClass}>
            {body}
          </form>
        ) : (
          <div className={bodyClass}>{body}</div>
        )}
      </main>
    </div>
  );
}
