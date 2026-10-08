import { Button } from "@aiden/ui-web";
import { Trans } from "@lingui/react/macro";
import { Link } from "react-router-dom";
import { desktopBridge } from "../lib/desktop";
import { WindowChrome } from "./WindowChrome";
import { Enterprise } from "./welcome/Enterprise";
import { FilmButton } from "./welcome/Film";
import { Week } from "./welcome/Week";

// The signed-out welcome: a light, quiet page that shows one week of working with Nova. Always
// light, whatever the app theme (`welcome-*` tokens).
const FOCUS = "focus-visible:ring-welcome-me/60";
const GUTTER = "px-[clamp(16px,4vw,40px)]";

function GetStarted() {
  return (
    <Button
      size="lg"
      nativeButton={false}
      render={<Link to="/sign-up" />}
      className={`h-auto rounded-full bg-welcome-ink px-[22px] py-[13px] text-[15px] font-semibold text-welcome-paper hover:bg-welcome-ink/90 ${FOCUS}`}
    >
      <Trans>Get started</Trans>
    </Button>
  );
}

export function WelcomePage() {
  return (
    <div
      className="h-full overflow-x-clip overflow-y-auto bg-welcome-bg text-welcome-ink antialiased"
      data-aiden-surface="welcome"
    >
      <header className={`mx-auto flex max-w-[1120px] items-center gap-5 py-[22px] ${GUTTER}`}>
        {/* Window controls only inside the desktop app; on the web the wordmark sits flush left. */}
        {desktopBridge() ? <WindowChrome /> : null}
        <span className="flex items-center gap-[9px] text-xl font-semibold tracking-[-0.02em]">
          <span aria-hidden="true" className="welcome-orb size-[18px] rounded-full" />
          nova
        </span>
        <span className="flex-1" />
        <Link
          to="/sign-in"
          className="whitespace-nowrap text-sm text-welcome-ink-2 hover:text-welcome-ink focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-welcome-me"
        >
          <Trans>Sign in</Trans>
        </Link>
        <Link
          to="/sign-up"
          className="whitespace-nowrap rounded-full bg-welcome-ink px-4 py-2 text-sm text-welcome-paper focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-welcome-me"
        >
          <Trans>Get started</Trans>
        </Link>
      </header>

      <main>
        <section
          className={`mx-auto max-w-[1120px] pt-[clamp(48px,10vh,110px)] pb-10 text-center ${GUTTER}`}
        >
          <h1 className="m-0 text-[clamp(44px,7vw,96px)] font-normal leading-[0.98] tracking-[-0.04em] text-balance">
            <Trans>
              Hand it off.
              <br />
              Nova's already on it.
            </Trans>
          </h1>
          <p className="mx-auto mt-5 max-w-[40ch] text-[clamp(17px,1.6vw,20px)] leading-[1.5] text-welcome-ink-2">
            <Trans>Here is one week of working with it.</Trans>
          </p>
          <div className="mt-[30px] flex flex-wrap justify-center gap-3">
            <GetStarted />
            <Button
              size="lg"
              variant="outline"
              nativeButton={false}
              render={<Link to="/sign-in" />}
              className={`h-auto rounded-full border-welcome-line bg-transparent px-[22px] py-[13px] text-[15px] font-semibold text-welcome-ink hover:bg-transparent dark:border-welcome-line dark:bg-transparent dark:hover:bg-transparent ${FOCUS}`}
            >
              <Trans>I have an account</Trans>
            </Button>
          </div>
          <div className="mt-14 font-mono text-[11px] tracking-[0.18em] text-welcome-ink-3">
            <Trans>SCROLL THROUGH THE WEEK</Trans>
          </div>
        </section>

        <Week />
        <Enterprise />

        <section className={`px-[clamp(16px,4vw,40px)] pt-[4vh] pb-[12vh] text-center`}>
          <h2 className="m-0 text-[clamp(40px,6vw,84px)] font-normal leading-none tracking-[-0.04em]">
            <Trans>
              Same conversation.
              <br />
              All week.
            </Trans>
          </h2>
          <div className="mt-[30px] flex flex-wrap items-center justify-center gap-3">
            <GetStarted />
            <FilmButton />
          </div>
        </section>
      </main>

      <footer
        className={`mx-auto flex max-w-[1120px] flex-wrap justify-between gap-3 border-t border-welcome-line pt-5 pb-8 text-[13px] text-welcome-ink-3 ${GUTTER}`}
      >
        <span>nova</span>
        <span>
          <Trans>Your computer · Your model · Your say</Trans>
        </span>
      </footer>
    </div>
  );
}
