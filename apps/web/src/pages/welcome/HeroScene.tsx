import { cn } from "@aiden/ui-web";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { DenseOrb } from "../../components/ai/orb/DenseOrb";
import { Bubble } from "./Bubble";
import { Ask, WorkingRow } from "./Snippets";

// The hero conversation: user message, working row, reply, plan file, ask card.
const FINAL_STAGE = 5;
const STEP_INTERVAL_MS = 900;
const LOOP_MS = 15500;
const STAGE_AT_MS = [500, 1500, 5300, 6400, 7600];
const WORKING_AT_MS = 1500;

export function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function useConversation(stepCount: number) {
  const [reduced] = useState(prefersReducedMotion);
  const [stage, setStage] = useState(reduced ? FINAL_STAGE : 0);
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (reduced) return;
    let timers: number[] = [];
    const play = () => {
      setStage(0);
      setStep(0);
      const at = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, ms));
      STAGE_AT_MS.forEach((ms, i) => {
        at(ms, () => setStage(i + 1));
      });
      for (let i = 1; i < stepCount; i++)
        at(WORKING_AT_MS + i * STEP_INTERVAL_MS, () => setStep(i));
      at(LOOP_MS, play);
    };
    play();
    return () => {
      for (const id of timers) clearTimeout(id);
      timers = [];
    };
  }, [reduced, stepCount]);

  return { stage, step };
}

function Item({ shown, children }: { shown: boolean; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "flex transition-[opacity,translate] duration-500 motion-reduce:transition-none",
        !shown && "translate-y-2 opacity-0",
      )}
    >
      {children}
    </div>
  );
}

export function HeroScene() {
  const { t } = useLingui();
  const steps = [
    t`Comparing 6 flights`,
    t`Reading 14 hotel reviews`,
    t`Checking May weather`,
    t`Writing a 5-day plan`,
  ];
  const { stage, step } = useConversation(steps.length);
  const working = stage === 2;

  return (
    <div className="relative mt-7 overflow-hidden rounded-[28px] py-14 pb-[72px]">
      <DenseOrb
        dim={0.85}
        className="pointer-events-none absolute left-1/2 top-1/2 aspect-square w-[min(1000px,125vw)] -translate-x-1/2 -translate-y-1/2 opacity-95 [mask-image:linear-gradient(to_bottom,transparent_0,black_18%,black_78%,transparent_100%)]"
      />
      <div
        role="img"
        aria-label={t`A Nova conversation: planning a weekend in Lisbon`}
        className="relative z-10 mx-auto grid min-h-[520px] max-w-[880px] overflow-hidden rounded-[20px] border border-welcome-hair-2 bg-welcome-win/85 shadow-[0_40px_120px_rgba(0,0,0,0.6)] backdrop-blur-[18px] md:grid-cols-[200px_1fr]"
      >
        <aside className="hidden flex-col gap-1 border-e border-welcome-hair p-3 pt-4 text-[13px] text-welcome-ink-2 md:flex">
          <div className="mb-2.5 flex items-center gap-2 font-semibold text-welcome-ink">
            <DenseOrb className="size-[26px]" />
            Nova
          </div>
          <div className="rounded-[9px] bg-welcome-me px-2.5 py-[7px] text-white">
            {t`Conversation`}
          </div>
          <div className="mx-2.5 mb-1 mt-3 text-[11px] text-welcome-ink-3">{t`Open · 2`}</div>
          <Fork dot="bg-welcome-rose">{t`Hotel near the river?`}</Fork>
          <Fork dot="bg-welcome-sky">{t`Gift for Mia`}</Fork>
          <div className="mx-2.5 mb-1 mt-3 text-[11px] text-welcome-ink-3">Nova</div>
          <div className="px-2.5 py-[7px]">{t`Goals`}</div>
          <div className="px-2.5 py-[7px]">{t`Library`}</div>
          <div className="px-2.5 py-[7px]">{t`Waiting on you`}</div>
        </aside>
        <div className="flex min-w-0 flex-col">
          <div className="flex items-center gap-2.5 border-b border-welcome-hair px-5 py-3.5 text-sm font-semibold">
            {t`Conversation`}
            <span className="text-xs font-normal text-welcome-ink-3">
              {working ? t`Working` : t`Ready`}
            </span>
          </div>
          <div className="flex flex-1 flex-col justify-end gap-3 p-5">
            <Item shown={stage >= 1}>
              <Bubble
                you
              >{t`Plan me 5 days in Lisbon in May. Not too touristy, good food, under $1,800.`}</Bubble>
            </Item>
            {stage < 3 && (
              <Item shown={stage >= 2}>
                <WorkingRow>
                  <span>{t`Working`}</span>
                  <span className="font-mono text-xs text-welcome-ink-3">{steps[step]}</span>
                </WorkingRow>
              </Item>
            )}
            <Item shown={stage >= 3}>
              <Bubble>
                {t`Done. Flights on the 14th are $310 cheaper, so I built the plan around them. Alfama for two nights, then Príncipe Real.`}
              </Bubble>
            </Item>
            <Item shown={stage >= 4}>
              <PlanCard />
            </Item>
            <Item shown={stage >= 5}>
              <Ask
                className="max-w-[420px]"
                title={t`Hold the two flights for 24 hours?`}
                detail={t`TAP 14 May, 2 seats, $642 total. Free to cancel until tomorrow 6pm.`}
                no={t`Not now`}
                yes={t`Hold them`}
              />
            </Item>
          </div>
          <div className="mx-5 mb-[18px] flex justify-between rounded-full border border-welcome-hair-2 px-4 py-[11px] text-sm text-welcome-ink-3">
            <span>{t`Ask Nova`}</span>
            <span className="grid size-6 place-items-center rounded-full bg-welcome-bubble text-[13px] text-welcome-ink-2">
              ↑
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function Fork({ dot, children }: { dot: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-[7px] px-2.5 py-[5px] text-[12.5px]">
      <i className={cn("size-[7px] rounded-full", dot)} />
      {children}
    </div>
  );
}

function PlanCard() {
  const { t } = useLingui();
  return (
    <div className="grid max-w-[420px] grid-cols-[1.2fr_0.8fr] gap-2.5 overflow-hidden rounded-2xl border border-welcome-hair-2 bg-linear-[140deg] from-welcome-file-from to-welcome-night to-65% p-3.5">
      <div>
        <small className="font-mono text-[10.5px] tracking-[0.06em] text-welcome-ink-3">
          {t`PLAN · PDF · 3 PAGES`}
        </small>
        <b className="mb-3 mt-1.5 block font-welcome text-2xl/[1.05] font-normal">
          {t`Lisbon,`}
          <br />
          {t`5 days`}
        </b>
        <span className="inline-block rounded-full bg-welcome-ink px-3.5 py-1.5 text-[12.5px] font-semibold text-welcome-night">
          {t`Open`}
        </span>
      </div>
      <div className="-mb-3.5 min-h-24 self-end rounded-t-lg bg-welcome-paper p-2.5 font-welcome text-[13px]/[1.2] text-welcome-paper-ink">
        {t`Day 1`}
        <br />
        <span className="text-[11px] text-welcome-paper-mute">
          {t`Alfama · Feira da Ladra · dinner at a tasca`}
        </span>
      </div>
    </div>
  );
}
