import { Trans, useLingui } from "@lingui/react/macro";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { R, Reveal } from "./reveal";

const BEAT = "flex flex-col gap-3 py-[2.4vh]";
const STAMP =
  "text-center font-mono text-[11px] tracking-[0.12em] text-welcome-ink-3 min-[821px]:hidden";
const BUBBLE =
  "max-w-[90%] rounded-[18px] px-[15px] py-[11px] text-[15.5px] leading-[1.45] min-[821px]:max-w-[82%]";
const YOU = `${BUBBLE} self-end rounded-br-[6px] bg-welcome-me text-welcome-paper`;
const NOVA = `${BUBBLE} self-start rounded-bl-[6px] bg-welcome-bubble`;
const CHIP =
  "inline-flex items-center gap-2 self-start rounded-full border border-welcome-chip-line bg-welcome-chip px-3 py-[7px] text-[13px] text-welcome-chip-ink";
const CARD =
  "rounded-[14px] border border-welcome-line bg-welcome-paper shadow-md shadow-welcome-ink/5";

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className={CHIP}>
      <i aria-hidden="true" className="size-[7px] rounded-full bg-welcome-me" />
      {children}
    </span>
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

const FILE_ICON =
  "grid h-11 w-9 place-items-center rounded-md border border-welcome-line bg-welcome-chip font-mono text-[9px] text-welcome-me";

function FileCard({ title, sub }: { title: ReactNode; sub: ReactNode }) {
  return (
    <div className={`flex items-center gap-3 self-start px-3.5 py-3 ${CARD}`}>
      <span className={FILE_ICON}>PDF</span>
      <div>
        <b className="block text-[14.5px]">{title}</b>
        <span className="text-[12.5px] text-welcome-ink-3">{sub}</span>
      </div>
    </div>
  );
}

function Tool({ glyph, tone, children }: { glyph: string; tone: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-[7px] rounded-full border border-welcome-line bg-welcome-paper py-1.5 pr-[11px] pl-1.5 text-[13px] text-welcome-ink-2">
      <i
        aria-hidden="true"
        className={`grid size-[22px] place-items-center rounded-[7px] text-xs text-welcome-paper not-italic ${tone}`}
      >
        {glyph}
      </i>
      {children}
    </span>
  );
}

function Beat({
  day,
  time,
  stamp,
  immediate,
  className = "",
  children,
}: {
  day: string;
  time: string;
  stamp: ReactNode;
  immediate?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Reveal
      className={`${BEAT} ${className}`}
      data-day={day}
      data-time={time}
      immediate={immediate}
    >
      <div className={STAMP}>{stamp}</div>
      {children}
    </Reveal>
  );
}

function Switch() {
  return (
    <span className="relative h-[18px] w-[30px] rounded-full bg-welcome-ok">
      <span className="absolute top-0.5 left-3.5 size-3.5 rounded-full bg-welcome-paper" />
    </span>
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
    <div className="mx-auto grid max-w-[1040px] grid-cols-1 gap-7 px-[clamp(16px,4vw,40px)] pt-[30px] pb-3 min-[821px]:grid-cols-[150px_minmax(0,1fr)]">
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

        <Beat
          day={t`MONDAY`}
          time="9:02"
          stamp={<Trans>MON 9:02</Trans>}
          immediate
          className="pt-1"
        >
          <R i={0} className={YOU}>
            <Trans>Prep me for Thursday's review with Northwind. Maya will be there.</Trans>
          </R>
          <R i={1} className="flex flex-wrap gap-2">
            <Tool glyph="✉" tone="bg-welcome-rose">
              <Trans>Email · 4 threads</Trans>
            </Tool>
            <Tool glyph="◷" tone="bg-welcome-me">
              <Trans>Calendar · Thu 2:00</Trans>
            </Tool>
            <Tool glyph="▦" tone="bg-welcome-ok">
              <Trans>CRM · Q3 numbers</Trans>
            </Tool>
            <Tool glyph="◎" tone="bg-welcome-violet">
              <Trans>Web · 6 pages</Trans>
            </Tool>
          </R>
          <R i={2} className="flex items-center gap-2.5 text-sm text-welcome-ink-2">
            <span className="size-2 animate-[welcomePulse_1.4s_infinite] rounded-full bg-welcome-me motion-reduce:animate-none" />
            <Trans>Working</Trans>{" "}
            <span className="font-mono text-xs text-welcome-ink-3">
              <Trans>reading the threads · pulling Q3 · checking the news</Trans>
            </span>
          </R>
        </Beat>

        <Beat day={t`MONDAY`} time="9:10" stamp={<Trans>MON 9:10</Trans>}>
          <R
            i={0}
            className="self-stretch overflow-hidden rounded-2xl bg-welcome-pc shadow-xl shadow-welcome-pc/20"
          >
            <div className="flex items-center justify-between bg-welcome-pc/50 px-3 py-2 text-xs text-welcome-pc-mute">
              <span className="inline-flex items-center gap-[7px]">
                <i aria-hidden="true" className="size-[7px] rounded-full bg-welcome-live" />
                <Trans>Nova's computer · Live</Trans>
              </span>
              <span className="rounded-full border border-welcome-pc-mute/40 px-2.5 py-0.5 text-welcome-pc-ink">
                <Trans>Take over</Trans>
              </span>
            </div>
            <div className="relative leading-[0]">
              <img
                src="/welcome/computer-crm.jpg"
                alt={t`Nova's computer: a browser open on the Northwind account in a CRM`}
                width={1280}
                height={800}
                loading="lazy"
                className="block h-auto w-full"
              />
              <span
                aria-hidden="true"
                className={`absolute top-[85%] left-[80%] size-4 bg-welcome-rose transition-[left,top] delay-300 duration-[900ms] ease-[cubic-bezier(.3,.7,.2,1)] [clip-path:polygon(0_0,100%_55%,55%_60%,40%_100%)] group-data-[in=true]:top-[33%] group-data-[in=true]:left-[56%] motion-reduce:transition-none`}
              />
            </div>
          </R>
          <R
            i={1}
            className="my-1.5 flex items-center gap-3 self-center font-mono text-[11.5px] tracking-[0.04em] text-welcome-ink-3 before:h-px before:w-[60px] before:bg-welcome-line before:content-[''] after:h-px after:w-[60px] after:bg-welcome-line after:content-['']"
          >
            <Trans>you were in meetings · Nova worked 2h 38m</Trans>
          </R>
        </Beat>

        <Beat day={t`MONDAY`} time="11:40" stamp={<Trans>MON 11:40</Trans>}>
          <R i={0} className={NOVA}>
            <Trans>
              The brief is ready. In July you said Legal reviews any renewal over $40k, so I added
              Dana from Legal to Thursday.
            </Trans>
          </R>
          <R i={1} className="self-start">
            <Chip>
              <Trans>Remembered from July</Trans>
            </Chip>
          </R>
          <R i={2} className="self-start">
            <FileCard
              title={<Trans>Northwind Q3 Review</Trans>}
              sub={<Trans>4 pages · ready to share</Trans>}
            />
          </R>
        </Beat>

        <Beat day={t`MONDAY`} time="14:00" stamp={<Trans>MON 14:00</Trans>}>
          <R
            i={0}
            className="self-stretch overflow-hidden rounded-2xl border border-welcome-line bg-welcome-canvas"
          >
            <div className="flex items-center justify-between border-b border-welcome-line px-3.5 py-[9px] text-[13px] font-semibold">
              <span>
                <Trans>Northwind Q3 Review</Trans>
              </span>
              <span
                className={`inline-grid rounded-full border border-welcome-line px-2 py-px font-mono text-[11px] font-normal text-welcome-ink-3 transition-colors delay-[2600ms] group-data-[in=true]:border-welcome-pc-bar group-data-[in=true]:text-welcome-me motion-reduce:transition-none`}
              >
                <span
                  className={`col-start-1 row-start-1 transition-opacity delay-[2600ms] group-data-[in=true]:opacity-0 motion-reduce:transition-none`}
                >
                  v1
                </span>
                <span
                  className={`col-start-1 row-start-1 opacity-0 transition-opacity delay-[2600ms] group-data-[in=true]:opacity-100 motion-reduce:transition-none`}
                >
                  v2
                </span>
              </span>
            </div>
            <div className="relative m-3.5 rounded-[10px] border border-welcome-line bg-welcome-paper px-[18px] pt-4 pb-[18px]">
              <h5 className="m-0 mb-2.5 text-lg font-medium tracking-[-0.02em]">
                <Trans>Q3 at a glance</Trans>
              </h5>
              <div
                className={`relative mt-[26px] h-[110px] rounded-lg p-2.5 outline-2 outline-offset-4 outline-transparent transition-[outline-color] delay-[600ms] group-data-[in=true]:outline-welcome-me motion-reduce:transition-none`}
              >
                <span
                  className={`absolute -top-6 left-0 rounded-md bg-welcome-me px-[7px] py-0.5 font-mono text-[10px] text-welcome-paper opacity-0 transition-opacity delay-[700ms] duration-300 group-data-[in=true]:opacity-100 motion-reduce:transition-none`}
                >
                  <Trans>Chart · revenue by quarter</Trans>
                </span>
                <div
                  className={`flex h-full items-end gap-[14%] px-[6%] transition-opacity delay-[2300ms] duration-[400ms] group-data-[in=true]:opacity-0 motion-reduce:transition-none`}
                >
                  {[40, 52, 47, 68].map((h) => (
                    <i
                      key={h}
                      className="flex-1 rounded-t-[3px] bg-welcome-pc-bar"
                      style={{ height: `${h}%` }}
                    />
                  ))}
                </div>
                <svg
                  aria-hidden="true"
                  viewBox="0 0 100 40"
                  preserveAspectRatio="none"
                  className={`absolute inset-2.5 h-[calc(100%-20px)] w-[calc(100%-20px)] opacity-0 transition-opacity delay-[2400ms] duration-500 group-data-[in=true]:opacity-100 motion-reduce:transition-none`}
                >
                  <polyline
                    points="5,30 35,22 65,25 95,8"
                    className="fill-none stroke-welcome-me"
                    strokeWidth={2.2}
                    vectorEffect="non-scaling-stroke"
                  />
                  <line
                    x1="0"
                    y1="12"
                    x2="100"
                    y2="12"
                    className="stroke-welcome-rose"
                    strokeWidth={1.4}
                    strokeDasharray="4 4"
                    vectorEffect="non-scaling-stroke"
                  />
                </svg>
              </div>
              <div
                className={`absolute right-[18px] bottom-3.5 max-w-[62%] translate-y-1.5 rounded-[12px_12px_4px_12px] bg-welcome-ink px-[11px] py-2 text-[12.5px] leading-[1.4] text-welcome-paper opacity-0 shadow-lg shadow-welcome-ink/25 transition-[opacity,transform] delay-[1200ms] duration-[400ms] group-data-[in=true]:translate-y-0 group-data-[in=true]:opacity-100 motion-reduce:transition-none`}
              >
                <b className="mr-1 font-semibold text-welcome-pc-bar">
                  <Trans>You</Trans>
                </b>
                <Trans>Make this a line chart and show the target.</Trans>
              </div>
            </div>
          </R>
          <R i={1} className={NOVA}>
            <Trans>Done. It's a line chart now, with the target marked. Saved as v2.</Trans>
          </R>
        </Beat>

        <Beat day={t`TUESDAY`} time="10:15" stamp={<Trans>TUE 10:15</Trans>}>
          <R i={0} className={NOVA}>
            <Trans>Revenue is up 8%. Usage dipped in August, then recovered.</Trans>
          </R>
          <R i={1} className="flex items-center gap-1.5 self-end text-[13px] text-welcome-ink-3">
            ↳{" "}
            <b className="font-medium text-welcome-rose">
              <Trans>Why did usage dip in August?</Trans>
            </b>{" "}
            · <Trans>forked from this message</Trans>
          </R>
          <R
            i={2}
            className="ml-[18px] flex flex-col gap-2.5 self-stretch border-l-2 border-welcome-rose pl-3.5"
          >
            <div className={NOVA}>
              <Trans>
                Two of their teams paused for a system migration. Both were back in September.
              </Trans>
            </div>
          </R>
        </Beat>

        <Beat day={t`TUESDAY`} time="16:30" stamp={<Trans>TUE 16:30</Trans>}>
          <R
            i={0}
            className="grid self-stretch overflow-hidden rounded-2xl border border-welcome-line max-[820px]:grid-cols-1 min-[821px]:grid-cols-[170px_1fr]"
          >
            <div className="flex flex-col gap-1.5 bg-welcome-panel p-3 text-[13px] max-[820px]:flex-row max-[820px]:flex-wrap">
              <span className="mb-0.5 text-[11px] text-welcome-ink-3">
                <Trans>Side chats</Trans>
              </span>
              <span className="rounded-lg bg-welcome-me px-2.5 py-[7px] text-welcome-paper">
                <Trans>Pricing proposal</Trans>
              </span>
              <span className="rounded-lg px-2.5 py-[7px] text-welcome-ink-2">
                <Trans>Hiring plan</Trans>
              </span>
            </div>
            <div className="flex flex-col gap-2.5 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2.5 text-sm font-semibold">
                <Trans>Pricing proposal</Trans>
                <span className="inline-flex items-center gap-[7px] text-xs font-normal text-welcome-ink-2">
                  <Switch />
                  <Trans>Knows our conversation</Trans>
                </span>
              </div>
              <div className={YOU}>
                <Trans>Draft a pricing proposal for Northwind's second team.</Trans>
              </div>
              <div className={NOVA}>
                <Trans>Here's a draft, using the discount we agreed on in May.</Trans>
              </div>
            </div>
          </R>
        </Beat>

        <Beat day={t`WEDNESDAY`} time="10:05" stamp={<Trans>WED 10:05</Trans>}>
          <R i={0} className={NOVA}>
            <Trans>
              You exported the renewals by hand again. Show me once, and I'll do it every Monday.
            </Trans>
          </R>
          <R i={1} className="flex items-center gap-2 text-[13px] text-welcome-rec">
            <i
              aria-hidden="true"
              className="size-[9px] animate-[welcomeBlink_1.2s_steps(2)_infinite] rounded-full bg-welcome-rec-dot shadow-[0_0_0_4px] shadow-welcome-rec-dot/20 motion-reduce:animate-none"
            />
            <Trans>Recording · you show, Nova watches</Trans>
          </R>
          <R i={2} className="self-stretch">
            <ol className="m-0 grid list-none gap-[7px] p-0 [counter-reset:s]">
              {[
                <Trans key="1">Open the CRM</Trans>,
                <Trans key="2">Filter renewals in the next 30 days</Trans>,
                <Trans key="3">Export to a sheet</Trans>,
                <Trans key="4">Email it to Maya</Trans>,
              ].map((step) => (
                <li
                  key={step.key}
                  className="flex items-center gap-2.5 rounded-xl border border-welcome-line bg-welcome-paper px-3 py-[9px] text-sm [counter-increment:s] before:grid before:size-[22px] before:place-items-center before:rounded-full before:bg-welcome-chip before:font-mono before:text-[11px] before:text-welcome-chip-ink before:content-[counter(s)]"
                >
                  {step}
                </li>
              ))}
            </ol>
          </R>
          <R i={3} className="self-start">
            <Chip>
              <Trans>Saved skill: weekly renewals report · Mondays 8:00</Trans>
            </Chip>
          </R>
        </Beat>

        <Beat day={t`THURSDAY`} time="13:45" stamp={<Trans>THU 13:45</Trans>}>
          <R i={0} className={NOVA}>
            <Trans>
              Your Northwind review starts in 15 minutes. Here's the one-pager Maya likes to see
              first.
            </Trans>
          </R>
          <R i={1} className="self-start">
            <FileCard
              title={<Trans>Northwind · one page</Trans>}
              sub={<Trans>Top: the two open risks</Trans>}
            />
          </R>
        </Beat>

        <Beat day={t`FRIDAY`} time="9:30" stamp={<Trans>FRI 9:30</Trans>}>
          <R
            i={0}
            className={`grid w-[min(100%,460px)] gap-2.5 self-start p-3.5 ${CARD} rounded-2xl`}
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
        </Beat>
      </section>
    </div>
  );
}
