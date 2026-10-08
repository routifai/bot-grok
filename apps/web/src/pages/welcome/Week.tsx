import { Trans, useLingui } from "@lingui/react/macro";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { R, Reveal, useShown } from "./reveal";

const BEAT = "flex flex-col gap-3 py-[6vh]";
const STAMP =
  "text-center font-mono text-[11px] tracking-[0.12em] text-welcome-ink-3 min-[821px]:hidden";
const BUBBLE =
  "max-w-[90%] rounded-[18px] px-[15px] py-[11px] text-[15.5px] leading-[1.45] min-[821px]:max-w-[82%]";
const YOU = `${BUBBLE} self-end rounded-br-[6px] bg-welcome-me text-welcome-paper`;
const NOVA = `${BUBBLE} self-start rounded-bl-[6px] bg-welcome-bubble`;
const CHIP =
  "inline-flex items-center gap-2 self-start rounded-full border border-welcome-chip-line bg-welcome-chip px-3 py-[7px] text-[13px] text-welcome-chip-ink";
const PILL = "rounded-full px-3.5 py-2 text-[13.5px] font-semibold";

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className={CHIP}>
      <i aria-hidden="true" className="size-[7px] rounded-full bg-welcome-me" />
      {children}
    </span>
  );
}

function Bars() {
  const shown = useShown();
  const heights = [42, 55, 48, 63, 58, 86];
  return (
    <div className="flex h-14 items-end gap-1.5">
      {heights.map((h, i) => (
        <i
          key={`${h}`}
          className={`flex-1 rounded-t-[3px] transition-[height] duration-[800ms] ease-out motion-reduce:transition-none ${
            i === 5 ? "bg-welcome-me" : "bg-welcome-pc-bar"
          }`}
          style={{ height: shown ? `${h}%` : "8%" }}
        />
      ))}
    </div>
  );
}

function Rail({ day, time, progress }: { day: string; time: string; progress: number }) {
  return (
    <aside aria-hidden="true" className="sticky top-[32vh] self-start font-mono max-[820px]:hidden">
      <div className="text-[13px] tracking-[0.14em] text-welcome-ink-3">{day}</div>
      <div className="mt-0.5 text-[34px] tracking-[-0.02em] tabular-nums text-welcome-ink">
        {time}
      </div>
      <div className="mt-4 h-0.5 overflow-hidden rounded-sm bg-welcome-line">
        <i
          className="block h-full bg-welcome-ink transition-[width] duration-[400ms] motion-reduce:transition-none"
          style={{ width: `${progress}%` }}
        />
      </div>
    </aside>
  );
}

export function Week() {
  const { t } = useLingui();
  const threadRef = useRef<HTMLDivElement>(null);
  const [rail, setRail] = useState({ day: "MONDAY", time: "9:02", progress: 0 });

  // The rail follows the moment nearest the middle of the screen. IntersectionObserver only.
  useEffect(() => {
    const root = threadRef.current;
    if (!root || typeof IntersectionObserver !== "function") return;
    const beats = [...root.querySelectorAll<HTMLElement>("[data-day]")];
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const el = e.target as HTMLElement;
          setRail({
            day: el.dataset.day ?? "",
            time: el.dataset.time ?? "",
            progress: ((beats.indexOf(el) + 1) / beats.length) * 100,
          });
        }
      },
      { rootMargin: "-45% 0px -45% 0px" },
    );
    for (const b of beats) io.observe(b);
    return () => io.disconnect();
  }, []);

  return (
    <div className="mx-auto grid max-w-[1040px] grid-cols-1 gap-7 px-[clamp(16px,4vw,40px)] pt-[30px] pb-10 min-[821px]:grid-cols-[150px_minmax(0,1fr)]">
      <Rail {...rail} />
      <section
        ref={threadRef}
        aria-label={t`One Nova conversation across a work week`}
        className="flex max-w-[700px] flex-col gap-3.5 rounded-[28px] border border-welcome-line bg-welcome-paper p-[clamp(18px,3vw,36px)]"
      >
        <div className="flex items-center gap-2.5 border-b border-welcome-line pb-3.5 font-semibold">
          <span aria-hidden="true" className="welcome-orb size-[18px] rounded-full" />
          Nova
          <small className="text-[13px] font-normal text-welcome-ink-3">
            · <Trans>one conversation</Trans>
          </small>
        </div>

        <Reveal className={BEAT} data-day={t`MONDAY`} data-time="9:02">
          <div className={STAMP}>
            <Trans>MON 9:02</Trans>
          </div>
          <R i={0} className={YOU}>
            <Trans>Prep me for Thursday's review with Northwind. Maya will be there.</Trans>
          </R>
          <R i={1} className="flex items-center gap-2.5 text-sm text-welcome-ink-2">
            <span className="size-2 animate-[welcomePulse_1.4s_infinite] rounded-full bg-welcome-me motion-reduce:animate-none" />
            <Trans>Working</Trans>{" "}
            <span className="font-mono text-xs text-welcome-ink-3">
              <Trans>pulling Q3 numbers · reading last month's notes</Trans>
            </span>
          </R>
          <R
            i={2}
            className="w-[min(100%,460px)] self-start overflow-hidden rounded-[14px] bg-welcome-pc text-welcome-pc-ink shadow-lg shadow-welcome-pc/20"
          >
            <div className="flex items-center justify-between px-3 py-2 text-xs text-welcome-pc-mute">
              <span className="inline-flex items-center gap-1.5">
                <i aria-hidden="true" className="size-[7px] rounded-full bg-welcome-live" />
                <Trans>Nova's computer</Trans>
              </span>
              <span className="rounded-full border border-welcome-pc-mute/40 px-[9px] py-0.5">
                <Trans>Take over</Trans>
              </span>
            </div>
            <div className="mx-2.5 mb-2.5 grid gap-[9px] rounded-lg bg-welcome-pc-win p-3 text-[12.5px] text-welcome-pc-win-ink">
              <span className="font-mono text-[10px] text-welcome-pc-win-mute">
                crm.example.com/northwind
              </span>
              <div className="flex justify-between">
                <b>
                  <Trans>Northwind · Q3</Trans>
                </b>
                <span>
                  <Trans>Revenue +8%</Trans>
                </span>
              </div>
              <Bars />
            </div>
          </R>
        </Reveal>

        <Reveal className={BEAT} data-day={t`MONDAY`} data-time="11:40">
          <div className={STAMP}>
            <Trans>MON 11:40</Trans>
          </div>
          <R
            i={0}
            className="my-1.5 flex items-center gap-3 self-center font-mono text-[11.5px] tracking-[0.04em] text-welcome-ink-3 before:h-px before:w-[60px] before:bg-welcome-line before:content-[''] after:h-px after:w-[60px] after:bg-welcome-line after:content-['']"
          >
            <Trans>you were in meetings · Nova worked 2h 38m</Trans>
          </R>
          <R i={1} className={NOVA}>
            <Trans>The brief is ready. Two open risks are on page 1.</Trans>
          </R>
          <R
            i={2}
            className="flex items-center gap-3 self-start rounded-[14px] border border-welcome-line bg-welcome-paper px-3.5 py-3 shadow-md shadow-welcome-ink/5"
          >
            <span className="grid h-11 w-9 place-items-center rounded-md border border-welcome-line bg-welcome-chip font-mono text-[9px] text-welcome-me">
              PDF
            </span>
            <div>
              <b className="block text-[14.5px]">
                <Trans>Northwind Q3 Review</Trans>
              </b>
              <span className="text-[12.5px] text-welcome-ink-3">
                <Trans>4 pages · ready to share</Trans>
              </span>
            </div>
          </R>
        </Reveal>

        <Reveal className={BEAT} data-day={t`TUESDAY`} data-time="16:20">
          <div className={STAMP}>
            <Trans>TUE 16:20</Trans>
          </div>
          <R i={0} className={YOU}>
            <Trans>Why did their usage drop in August?</Trans>
          </R>
          <R i={1} className="flex items-center gap-1.5 self-end text-[13px] text-welcome-ink-3">
            ↳{" "}
            <b className="font-medium text-welcome-rose">
              <Trans>a side question</Trans>
            </b>{" "}
            · <Trans>the brief stays as it is</Trans>
          </R>
          <R
            i={2}
            className="ml-[18px] flex flex-col gap-2.5 self-stretch border-l-2 border-welcome-rose pl-3.5"
          >
            <div className={NOVA}>
              <Trans>
                Two of their teams paused for a system migration. Both came back in September.
              </Trans>
            </div>
          </R>
        </Reveal>

        <Reveal className={BEAT} data-day={t`WEDNESDAY`} data-time="10:05">
          <div className={STAMP}>
            <Trans>WED 10:05</Trans>
          </div>
          <R i={0} className={NOVA}>
            <Trans>You exported the renewals by hand again. Want me to do it every Monday?</Trans>
          </R>
          <R i={1} className="flex gap-2 self-start">
            <span className={`${PILL} bg-welcome-bubble text-welcome-ink-2`}>
              <Trans>Not now</Trans>
            </span>
            <span className={`${PILL} bg-welcome-ink text-welcome-paper`}>
              <Trans>Every Monday</Trans>
            </span>
          </R>
          <R i={2} className="self-start">
            <Chip>
              <Trans>Saved: weekly renewals report · Mondays 8:00</Trans>
            </Chip>
          </R>
        </Reveal>

        <Reveal className={BEAT} data-day={t`THURSDAY`} data-time="8:15">
          <div className={STAMP}>
            <Trans>THU 8:15</Trans>
          </div>
          <R i={0} className={NOVA}>
            <Trans>
              Maya likes the one-page summary first, so I put it on top, like last time.
            </Trans>
          </R>
          <R i={1} className="self-start">
            <Chip>
              <Trans>From three weeks ago</Trans>
            </Chip>
          </R>
        </Reveal>

        <Reveal className={BEAT} data-day={t`FRIDAY`} data-time="9:30">
          <div className={STAMP}>
            <Trans>FRI 9:30</Trans>
          </div>
          <R
            i={0}
            className="grid w-[min(100%,460px)] gap-2.5 self-start rounded-2xl border border-welcome-line bg-welcome-paper p-3.5 shadow-md shadow-welcome-ink/5"
          >
            <div className="flex items-center gap-2.5 font-semibold">
              <i
                aria-hidden="true"
                className="grid size-[26px] place-items-center rounded-lg bg-welcome-amber text-[13px] text-welcome-amber-ink not-italic"
              >
                ✉
              </i>
              <Trans>Send the follow-up to Maya?</Trans>
            </div>
            <p className="m-0 text-[13.5px] leading-[1.45] text-welcome-ink-2">
              <Trans>
                "Thanks for Thursday. The two risks we discussed are on page 1, with owners and
                dates."
              </Trans>
            </p>
            <div className="grid grid-cols-2 gap-2">
              <span className="rounded-[10px] bg-welcome-bubble p-[9px] text-center text-[13.5px] font-semibold text-welcome-ink-2">
                <Trans>Not now</Trans>
              </span>
              <span className="rounded-[10px] bg-welcome-ink p-[9px] text-center text-[13.5px] font-semibold text-welcome-paper">
                <Trans>Send</Trans>
              </span>
            </div>
          </R>
          <R i={1} className="self-start text-sm font-semibold text-welcome-ok">
            ✓ <Trans>Sent</Trans>
          </R>
        </Reveal>
      </section>
    </div>
  );
}
