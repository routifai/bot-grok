import { Trans } from "@lingui/react/macro";
import { GetStarted, GUTTER, HaveAccount } from "./Cta";

/** The closing call to action and the footer, on the light sheet. */
export function Closing() {
  return (
    <div className="relative z-2 bg-welcome-sheet text-welcome-ink">
      <div className={`mx-auto max-w-[1160px] ${GUTTER}`}>
        <section className="grid justify-items-center gap-[18px] pt-14 pb-16 text-center">
          <h2 className="welcome-display max-w-[15ch] text-[clamp(36px,5vw,64px)] leading-none font-normal tracking-[-0.035em] text-balance text-welcome-ink">
            <Trans>Give it the first thing on your list.</Trans>
          </h2>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <GetStarted tone="sheet" />
            <HaveAccount />
          </div>
        </section>
        <footer className="flex flex-wrap justify-between gap-3 border-t border-welcome-sheet-line pt-5 pb-8 text-[13px] text-welcome-mute">
          <span className="welcome-display text-lg text-welcome-sheet-ink-2">nova</span>
          <span>
            <Trans>Your computer · Your model · Your say</Trans>
          </span>
        </footer>
      </div>
    </div>
  );
}
