import { Link } from "react-router-dom";

/** Shared field/button looks for pages that wear the signed-out welcome surface. */
export const welcomeFieldClass =
  "mt-2 h-12 rounded-xl border-welcome-line bg-welcome-paper px-4 text-base text-welcome-ink placeholder:text-welcome-ink-3 focus-visible:border-welcome-me focus-visible:ring-welcome-me/25 md:text-base dark:bg-welcome-paper";
export const welcomeSubmitClass =
  "mt-4 h-12 w-full rounded-full bg-welcome-ink text-[15px] font-semibold text-welcome-paper hover:bg-welcome-ink/90 focus-visible:ring-welcome-me/60";

export const welcomeHeadingClass =
  "text-center text-[clamp(34px,5vw,44px)] font-normal leading-[1.02] tracking-[-0.035em] text-balance";

/** Same light surface as the signed-out welcome page (`welcome-*` tokens), whatever the theme. */
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
  const bodyClass = `flex ${width} max-w-full flex-col items-center`;
  return (
    <div
      className="flex min-h-full flex-col bg-welcome-bg text-welcome-ink antialiased"
      data-aiden-surface="welcome"
    >
      <header className="mx-auto flex w-full max-w-[1120px] items-center px-[clamp(16px,4vw,40px)] py-[22px]">
        <Link
          to="/"
          className="flex items-center gap-[9px] rounded-md text-xl font-semibold tracking-[-0.02em] focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-welcome-me"
        >
          <span aria-hidden="true" className="welcome-orb size-[18px] rounded-full" />
          nova
        </Link>
      </header>
      <main className="flex flex-1 items-center justify-center px-4 pb-[12vh]">
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
