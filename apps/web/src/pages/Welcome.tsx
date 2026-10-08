import "@fontsource-variable/newsreader/wght.css";
import "@fontsource-variable/newsreader/wght-italic.css";
import { Button } from "@aiden/ui-web";
import { Trans } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { desktopBridge } from "../lib/desktop";
import { WindowChrome } from "./WindowChrome";
import { Day } from "./welcome/Day";
import { Film } from "./welcome/Film";
import { HeroScene } from "./welcome/HeroScene";

// The signed-out welcome: a dark, cinematic page that shows Nova working. Always dark,
// whatever the app theme (`welcome-*` tokens).
const FOCUS = "focus-visible:ring-welcome-glow/60";

function Ctas() {
  return (
    <div className="mt-7 flex flex-wrap justify-center gap-3">
      <Button
        size="lg"
        nativeButton={false}
        render={<Link to="/sign-up" />}
        className={`h-auto rounded-full bg-welcome-ink px-[22px] py-[13px] text-[15px] font-semibold text-welcome-night hover:bg-white ${FOCUS}`}
      >
        <Trans>Get started</Trans>
      </Button>
      <Button
        size="lg"
        variant="outline"
        nativeButton={false}
        render={<Link to="/sign-in" />}
        className={`h-auto rounded-full border-welcome-hair-2 bg-transparent px-[22px] py-[13px] text-[15px] font-semibold text-welcome-ink-2 hover:bg-transparent hover:text-welcome-ink dark:border-welcome-hair-2 dark:bg-transparent dark:hover:bg-transparent ${FOCUS}`}
      >
        <Trans>I have an account</Trans>
      </Button>
    </div>
  );
}

function Pillar({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-2 bg-welcome-night px-6 py-[26px]">
      <h3 className="m-0 font-welcome text-[26px] font-normal tracking-[-0.01em]">{title}</h3>
      <p className="m-0 text-[15px] leading-[1.55] text-welcome-ink-2">{children}</p>
    </div>
  );
}

export function WelcomePage() {
  return (
    <div
      className="h-full overflow-x-hidden overflow-y-auto bg-welcome-night px-[clamp(16px,4vw,48px)] text-welcome-ink antialiased"
      data-aiden-surface="welcome"
    >
      <div className="mx-auto max-w-[1160px]">
        <header className="flex items-center gap-5 py-[22px]">
          {/* Window controls only inside the desktop app; on the web the wordmark sits flush left. */}
          {desktopBridge() ? <WindowChrome /> : null}
          <span className="flex items-center gap-2.5 font-welcome text-[26px] tracking-[-0.01em]">
            <i
              aria-hidden="true"
              className="size-[9px] rounded-full bg-radial-[at_30%_30%] from-welcome-glow-hi from-0% via-welcome-glow via-45% to-welcome-glow-lo shadow-[0_0_16px] shadow-welcome-glow"
            />
            nova
          </span>
          <span className="flex-1" />
          <Link
            to="/sign-in"
            className="whitespace-nowrap text-sm text-welcome-ink-2 hover:text-welcome-ink focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-welcome-glow"
          >
            <Trans>Sign in</Trans>
          </Link>
          <Link
            to="/sign-up"
            className="whitespace-nowrap rounded-full border border-welcome-hair-2 px-4 py-2 text-sm text-welcome-ink focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-welcome-glow"
          >
            <Trans>Get started</Trans>
          </Link>
        </header>

        <main>
          <section className="relative z-10 pt-10 pb-2 text-center">
            <h1 className="m-0 font-welcome text-[clamp(48px,7vw,96px)] font-light leading-[0.98] tracking-[-0.025em] text-balance">
              <Trans>
                Hand it off.
                <br />
                <em className="italic text-welcome-lilac">Nova's already on it.</em>
              </Trans>
            </h1>
            <p className="mx-auto mt-5 max-w-[46ch] text-[clamp(17px,1.5vw,19px)] leading-[1.55] text-welcome-ink-2">
              <Trans>
                Ask once and get on with your day. Nova researches, compares, drafts and books on
                its own computer, and checks with you before anything it can't undo.
              </Trans>
            </p>
            <Ctas />
          </section>

          <HeroScene />
          <Film />
          <Day />

          <section className="pt-[72px] pb-6" aria-label="Nova">
            <div className="grid grid-cols-1 gap-px overflow-hidden rounded-[20px] border border-welcome-hair bg-welcome-hair min-[820px]:grid-cols-3">
              <Pillar title={<Trans>Its own computer</Trans>}>
                <Trans>
                  A real browser and files in the cloud. Watch it work, or take over whenever you
                  like.
                </Trans>
              </Pillar>
              <Pillar title={<Trans>Your say, always</Trans>}>
                <Trans>
                  Paying, sending, booking, publishing: you say yes first. Everything else, it just
                  does.
                </Trans>
              </Pillar>
              <Pillar title={<Trans>Remembers what matters</Trans>}>
                <Trans>
                  Your preferences and plans, in a memory you can read, edit and clear at any time.
                </Trans>
              </Pillar>
            </div>
          </section>

          <section className="grid justify-items-center gap-[18px] pt-[88px] pb-16 text-center">
            <h2 className="m-0 max-w-[15ch] font-welcome text-[clamp(36px,5vw,64px)] font-light leading-none tracking-[-0.025em] text-balance">
              <Trans>
                Give it the first thing <em className="italic text-welcome-lilac">on your list.</em>
              </Trans>
            </h2>
            <Ctas />
          </section>
        </main>

        <footer className="flex flex-wrap justify-between gap-3 border-t border-welcome-hair pt-5 pb-8 text-[13px] text-welcome-ink-3">
          <span className="font-welcome text-lg text-welcome-ink-2">nova</span>
          <span>
            <Trans>Your computer · Your model · Your say</Trans>
          </span>
        </footer>
      </div>
    </div>
  );
}
