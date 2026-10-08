import { Trans, useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { Bubble } from "./Bubble";
import { Ask, WorkingRow } from "./Snippets";

function Moment({
  time,
  caption,
  children,
}: {
  time: string;
  caption: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <span className="flex items-center gap-2 font-mono text-xs text-welcome-ink-3 after:h-px after:flex-1 after:bg-welcome-hair">
        {time}
      </span>
      <div className="flex min-h-[270px] flex-1 flex-col gap-[9px] rounded-[20px] border border-welcome-hair bg-welcome-win p-3.5">
        {children}
        <p className="mt-auto border-t border-welcome-hair pt-1.5 text-[13px] leading-[1.45] text-welcome-ink-2">
          {caption}
        </p>
      </div>
    </div>
  );
}

const SNIPPET = "max-w-[90%] text-[13.5px]";

function Strong({ children }: { children: ReactNode }) {
  return <b className="font-semibold text-welcome-ink">{children}</b>;
}

export function Day() {
  const { t } = useLingui();
  return (
    <section className="pt-[72px] pb-6" aria-labelledby="welcome-day">
      <h2
        id="welcome-day"
        className="mb-9 font-welcome text-[clamp(34px,4.4vw,56px)] font-light leading-[1.02] tracking-[-0.02em] text-balance"
      >
        <Trans>A day with Nova.</Trans>
      </h2>
      <div className="grid grid-cols-1 gap-3.5 min-[560px]:grid-cols-2 min-[980px]:grid-cols-4">
        <Moment
          time="08:10"
          caption={
            <Trans>
              <Strong>It starts before you do.</Strong> A short morning note, only when something
              changed.
            </Trans>
          }
        >
          <Bubble className={SNIPPET}>
            {t`Rain after 3pm, so I moved your run to 7am. Mia's birthday is Saturday; I found three gifts she'd like.`}
          </Bubble>
          <Bubble you className={SNIPPET}>
            {t`The second one. Get it here by Friday.`}
          </Bubble>
          <Bubble className={SNIPPET}>{t`Ordered. Arrives Thursday.`}</Bubble>
        </Moment>
        <Moment
          time="12:40"
          caption={
            <Trans>
              <Strong>Ask on the side.</Strong> Fork any message into its own thread without losing
              your place.
            </Trans>
          }
        >
          <Bubble you className={SNIPPET}>
            {t`Is clause 14 of this lease normal?`}
          </Bubble>
          <div className="-mt-1.5 flex justify-end gap-1.5 text-xs text-welcome-ink-3">
            ↳ <b className="font-medium text-welcome-rose">{t`Lease, clause 14`}</b> ·{" "}
            {t`4 replies`}
          </div>
          <Bubble className={SNIPPET}>
            {t`It's stricter than usual: you'd pay for all repairs under $500. Worth asking to change.`}
          </Bubble>
        </Moment>
        <Moment
          time="16:05"
          caption={
            <Trans>
              <Strong>It asks before it acts.</Strong> Paying, sending, booking: always your call.
            </Trans>
          }
        >
          <Bubble className={SNIPPET}>
            {t`4 apartments under $2,100, all 5 minutes from the subway. Book viewings for Thursday evening?`}
          </Bubble>
          <Ask no={t`Not now`} yes={t`Book them`} />
        </Moment>
        <Moment
          time="21:30"
          caption={
            <Trans>
              <Strong>Real work, start to finish.</Strong> On its own computer, every step visible.
            </Trans>
          }
        >
          <Bubble you className={SNIPPET}>
            {t`Find a place for 6 on Friday, somewhere quiet.`}
          </Bubble>
          <WorkingRow>
            <span className="font-mono text-xs text-welcome-ink-3">{t`Checked 11 restaurants`}</span>
          </WorkingRow>
          <Bubble className={SNIPPET}>
            {t`Booked Tasca do Chico, 8pm, back room. I added it to your calendar.`}
          </Bubble>
        </Moment>
      </div>
    </section>
  );
}
