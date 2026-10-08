import { Trans, useLingui } from "@lingui/react/macro";
import { type Ref, useRef, useState } from "react";
import { BUBBLE, BUBBLE_YOU, DemoCard, DemoColumn, fx, fx2 } from "./DemoCard";
import { type Later, usePlayback } from "./hooks";

type CardProps = { active: boolean; cardRef: Ref<HTMLElement> };

/** Reveal beat `i` (1-based count) at `250 + i * 650` ms, the rhythm of the simple demos. */
function stagger(later: Later, count: number, set: (n: number) => void) {
  for (let i = 0; i < count; i++) later(250 + i * 650, () => set(i + 1));
}

export function RememberCard({ active, cardRef }: CardProps) {
  const [n, setN] = useState(0);
  usePlayback(active, {
    reset: () => setN(0),
    showAll: () => setN(6),
    play: (later) => stagger(later, 6, setN),
  });
  return (
    <DemoCard
      cardRef={cardRef}
      eyebrow={<Trans>ONE CONVERSATION</Trans>}
      title={<Trans>Remember</Trans>}
      body={<Trans>One thread that never resets. It keeps what matters about your work.</Trans>}
    >
      <DemoColumn>
        <div className={`${DIVIDER} ${fx(n > 0)}`}>
          <Trans>3 WEEKS AGO</Trans>
        </div>
        <div className={`${BUBBLE} ${BUBBLE_YOU} ${fx(n > 1)}`}>
          <Trans>Maya likes a one-page summary before any client call.</Trans>
        </div>
        <div className={`${DIVIDER} ${fx(n > 2)}`}>
          <Trans>TODAY</Trans>
        </div>
        <div className={`${BUBBLE} ${BUBBLE_YOU} ${fx(n > 3)}`}>
          <Trans>Prep me for Thursday's call with Northwind.</Trans>
        </div>
        <div className={`${CHIP} ${fx(n > 4)}`}>
          <i className="size-[7px] rounded-full bg-welcome-night-glow" />
          <Trans>Remembered: one page for Maya first</Trans>
        </div>
        <div className={`${BUBBLE} ${fx(n > 5)}`}>
          <Trans>
            Here's a one-page brief for Maya. The two open points from last month are at the top.
          </Trans>
        </div>
      </DemoColumn>
    </DemoCard>
  );
}

const DIVIDER = "text-center font-mono text-[11px] tracking-[0.08em] text-welcome-night-ink-3";
const CHIP =
  "inline-flex items-center gap-2 self-start rounded-full border border-welcome-night-glow/35 bg-welcome-night-glow/14 px-3 py-[7px] text-[13px] text-welcome-night-glow-ink-2";

export function BranchCard({ active, cardRef }: CardProps) {
  const [n, setN] = useState(0);
  usePlayback(active, {
    reset: () => setN(0),
    showAll: () => setN(3),
    play: (later) => {
      later(200, () => setN(1));
      later(900, () => setN(2));
      later(1900, () => setN(3));
    },
  });
  return (
    <DemoCard
      cardRef={cardRef}
      eyebrow={<Trans>SIDE CHATS & FORKS</Trans>}
      title={<Trans>Branch</Trans>}
      body={<Trans>Dig into one detail on the side. The main thread stays where it was.</Trans>}
    >
      <DemoColumn>
        <div className={`${BUBBLE} ${fx(n > 0)}`}>
          <Trans>The Q3 report draft is ready. Revenue is up 8%, churn ticked up in August.</Trans>
        </div>
        <div className={`relative self-end text-[13px] text-welcome-night-ink-3 ${fx(n > 1)}`}>
          <span
            className={`absolute top-[-6px] right-[20%] h-0.5 bg-linear-to-r from-transparent to-welcome-night-rose shadow-[0_0_12px] shadow-welcome-night-rose transition-[width] duration-800 ease-[ease] ${n > 1 ? "w-[120px]" : "w-0"}`}
          />
          ↳{" "}
          <b className="font-medium text-welcome-night-rose">
            <Trans>Why did churn rise in August?</Trans>
          </b>{" "}
          · <Trans>3 replies</Trans>
        </div>
        <div
          className={`ml-2 flex flex-col gap-2 border-l-2 border-welcome-night-rose pl-3 ${fx(n > 2)}`}
        >
          <div className={`${BUBBLE} ${BUBBLE_YOU}`}>
            <Trans>What drove it?</Trans>
          </div>
          <div className={BUBBLE}>
            <Trans>Two large accounts paused in August. Both renewed in September.</Trans>
          </div>
        </div>
      </DemoColumn>
    </DemoCard>
  );
}

const ACCT =
  "grid grid-cols-[1fr_auto_auto] items-center gap-3.5 rounded-lg border bg-welcome-paper px-2.5 py-[9px] text-[13px]";
const ACCT_SPAN = "text-xs text-welcome-mute";
const AMT = "font-semibold text-welcome-pc-win-ink tabular-nums";

export function WorkCard({ active, cardRef }: CardProps) {
  const { t } = useLingui();
  const [screen, setScreen] = useState(false);
  const [typed, setTyped] = useState("");
  const [rows, setRows] = useState(false);
  const [pick, setPick] = useState(false);
  const [exportOn, setExportOn] = useState(false);
  const [press, setPress] = useState(false);
  const [toast, setToast] = useState(false);
  const [cursor, setCursor] = useState({ left: "60%", top: "20%" });
  const screenRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLDivElement>(null);
  const acctRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLSpanElement>(null);

  // Move the cursor to a point inside an element, in the screen's own coordinates.
  const at = (el: HTMLElement | null, dx: number, dy: number) => {
    const scr = screenRef.current?.getBoundingClientRect();
    const b = el?.getBoundingClientRect();
    if (!scr || !b) return;
    setCursor({
      left: `${b.left - scr.left + b.width * dx}px`,
      top: `${b.top - scr.top + b.height * dy}px`,
    });
  };

  usePlayback(active, {
    reset: () => {
      setScreen(false);
      setTyped("");
      setRows(false);
      setPick(false);
      setExportOn(false);
      setPress(false);
      setToast(false);
      setCursor({ left: "60%", top: "20%" });
    },
    showAll: () => {
      setScreen(true);
      setTyped("Acme");
      setRows(true);
      setPick(true);
      setExportOn(true);
      setToast(true);
    },
    play: (later) => {
      setScreen(true);
      later(300, () => at(searchRef.current, 0.3, 0.5));
      for (let i = 0; i < 4; i++) later(1100 + i * 160, () => setTyped("Acme".slice(0, i + 1)));
      later(1900, () => setRows(true));
      later(2500, () => at(acctRef.current, 0.2, 0.5));
      later(3200, () => setPick(true));
      later(3600, () => setExportOn(true));
      later(3900, () => at(btnRef.current, 0.8, 0.6));
      later(4600, () => setPress(true));
      later(4800, () => {
        setPress(false);
        setToast(true);
      });
    },
  });

  return (
    <DemoCard
      wide
      cardRef={cardRef}
      eyebrow={<Trans>ITS OWN COMPUTER</Trans>}
      title={<Trans>Work</Trans>}
      body={<Trans>A real computer in the cloud. Watch it work, or take over any time.</Trans>}
    >
      <div
        ref={screenRef}
        className={`welcome-screen relative aspect-[16/10] overflow-hidden rounded-2xl border border-welcome-paper/14 shadow-[0_30px_80px_rgb(0_0_0/0.5)] ${fx(screen)}`}
      >
        <div className="flex items-center justify-between bg-welcome-night-bar/55 px-3 py-2 text-xs text-welcome-night-ink-2 backdrop-blur-[8px]">
          <span className="flex items-center gap-[7px]">
            <i className="size-[7px] rounded-full bg-welcome-live shadow-[0_0_0_3px] shadow-welcome-live/20" />
            <Trans>Nova's computer · Live</Trans>
          </span>
          <span className="rounded-full border border-welcome-paper/20 bg-welcome-paper/12 px-2.5 py-[3px] text-welcome-night-ink">
            <Trans>Take over</Trans>
          </span>
        </div>
        <div className="absolute inset-x-0 top-[34px] bottom-0 px-[5%] py-[4%]">
          <div className="h-[86%] overflow-hidden rounded-[10px] bg-welcome-pc-win text-welcome-pc-win-ink shadow-[0_20px_50px_rgb(0_0_0/0.45)]">
            <div className="flex items-center gap-1.5 bg-welcome-line px-2.5 py-[7px] font-mono text-[10px] text-welcome-mute">
              <i className="size-[7px] rounded-full bg-welcome-app-dot" />
              <i className="size-[7px] rounded-full bg-welcome-app-dot" />
              <i className="size-[7px] rounded-full bg-welcome-app-dot" />
              &nbsp;crm.example.com
            </div>
            <div className="grid gap-[9px] p-3.5 text-[13px]">
              <div
                ref={searchRef}
                className="flex items-center gap-2 rounded-lg border border-welcome-app-line bg-welcome-paper px-2.5 py-2"
              >
                <span className="text-xs text-welcome-app-hint">{t`Search accounts`}</span>
                <span className="font-semibold">{typed}</span>
                <span className="welcome-blink h-3.5 w-px bg-welcome-me" />
              </div>
              <div
                ref={acctRef}
                className={`${ACCT} ${fx2(rows)} ${pick ? "border-welcome-me shadow-[0_0_0_3px] shadow-welcome-me/15" : "border-welcome-app-line-2"}`}
              >
                <b>Acme Corp</b>
                <span className={ACCT_SPAN}>
                  <Trans>Renewal · 14 days</Trans>
                </span>
                <span className={`${ACCT_SPAN} ${AMT}`}>$48,000</span>
              </div>
              {/* This row starts dimmed, not hidden: the page's own CSS did the same. */}
              <div className={`${ACCT} border-welcome-app-line-2 ${fx2(rows, "opacity-60")}`}>
                <b>Acme Labs</b>
                <span className={ACCT_SPAN}>
                  <Trans>Active</Trans>
                </span>
                <span className={`${ACCT_SPAN} ${AMT}`}>$12,500</span>
              </div>
              <div className={`flex justify-end ${fx2(exportOn)}`}>
                <span
                  ref={btnRef}
                  className={`rounded-lg bg-welcome-ink px-3 py-[7px] text-xs font-semibold text-welcome-paper transition-transform duration-150 ${press ? "scale-[.94]" : ""}`}
                >
                  <Trans>Export renewals</Trans>
                </span>
              </div>
            </div>
          </div>
          <div
            className={`absolute right-[6%] bottom-[6%] rounded-[10px] border border-welcome-paper/15 bg-welcome-pc/90 px-3 py-[9px] text-xs text-welcome-night-ink ${fx2(toast)}`}
          >
            <Trans>renewals.csv saved to Files</Trans>
          </div>
        </div>
        <span
          aria-hidden="true"
          className="welcome-cursor absolute z-5 size-[18px] transition-[left,top] duration-700 ease-[cubic-bezier(.3,.7,.2,1)]"
          style={cursor}
        />
      </div>
    </DemoCard>
  );
}

export function LearnCard({ active, cardRef }: CardProps) {
  const [n, setN] = useState(0);
  const [on, setOn] = useState(false);
  usePlayback(active, {
    reset: () => {
      setN(0);
      setOn(false);
    },
    showAll: () => {
      setN(7);
      setOn(true);
    },
    play: (later) => {
      stagger(later, 7, setN);
      later(250 + 5 * 650 + 500, () => setOn(true));
    },
  });
  const steps = [
    <Trans key="a">Open the CRM</Trans>,
    <Trans key="b">Search the account</Trans>,
    <Trans key="c">Export renewals</Trans>,
    <Trans key="d">Email the file to Maya</Trans>,
  ];
  return (
    <DemoCard
      cardRef={cardRef}
      eyebrow={<Trans>SKILLS</Trans>}
      title={<Trans>Learn</Trans>}
      body={<Trans>Show it a task once. From then on, it does it for you.</Trans>}
    >
      <DemoColumn>
        <div
          className={`flex items-center gap-2 text-[13px] text-welcome-night-rec-ink ${fx(n > 0)}`}
        >
          <i className="welcome-rec-blink size-[9px] rounded-full bg-welcome-rec-dot shadow-[0_0_0_4px] shadow-welcome-rec-dot/20" />
          <Trans>Recording · you show, Nova watches</Trans>
        </div>
        <ol className="m-0 grid list-none gap-2 p-0">
          {steps.map((s, i) => (
            <li
              key={s.key}
              className={`flex items-center gap-2.5 rounded-xl border border-welcome-paper/8 bg-welcome-night-panel px-3 py-2.5 text-sm ${fx(n > i + 1)}`}
            >
              <span className="grid size-[22px] place-items-center rounded-full bg-welcome-night-glow/18 font-mono text-[11px] text-welcome-night-glow-ink-2">
                {i + 1}
              </span>
              {s}
            </li>
          ))}
        </ol>
        <div
          className={`flex items-center justify-between rounded-[14px] border border-welcome-night-glow/40 bg-linear-[135deg] from-welcome-night-glow/22 to-welcome-night-rose/12 px-3.5 py-3 ${fx(n > 5)}`}
        >
          <div>
            <small className="block font-mono text-[10px] tracking-[0.1em] text-welcome-night-glow-ink">
              <Trans>NEW SKILL</Trans>
            </small>
            <b className="text-base">
              <Trans>Weekly renewal report</Trans>
            </b>
          </div>
          <span
            className={`relative h-6 w-10 rounded-full transition-colors duration-300 ${on ? "bg-welcome-live" : "bg-welcome-night-switch"}`}
          >
            <span
              className={`absolute top-[3px] size-[18px] rounded-full bg-welcome-paper transition-[left] duration-300 ${on ? "left-[19px]" : "left-[3px]"}`}
            />
          </span>
        </div>
        <div className={`font-mono text-xs text-welcome-night-ink-3 ${fx(n > 6)}`}>
          <Trans>Runs every Monday · 8:00</Trans>
        </div>
      </DemoColumn>
    </DemoCard>
  );
}

export function CreateCard({ active, cardRef }: CardProps) {
  const { t } = useLingui();
  const lines = [
    t`Summary — Revenue up 8% quarter on quarter, led by three renewals.`,
    t`Highlights — Northwind expanded to two teams; Acme signed for two years.`,
    t`Risks — August churn from two paused accounts, both now renewed.`,
    t`Next steps — Review pricing with Maya on Thursday; send the deck Friday.`,
  ];
  const [doc, setDoc] = useState(false);
  // How much of the report is written: whole lines, plus characters of the line being typed.
  const [typed, setTyped] = useState<string[]>([]);
  usePlayback(active, {
    reset: () => {
      setDoc(false);
      setTyped([]);
    },
    showAll: () => {
      setDoc(true);
      setTyped(lines);
    },
    play: (later) => {
      setDoc(true);
      let li = 0;
      let ci = 0;
      const tick = () => {
        if (li >= lines.length) return;
        ci++;
        const line = lines[li] ?? "";
        const done = ci >= line.length;
        const at = li;
        const slice = line.slice(0, ci);
        setTyped((prev) => [...prev.slice(0, at), slice]);
        if (done) {
          li++;
          ci = 0;
          later(250, tick);
        } else later(18, tick);
      };
      later(400, tick);
    },
  });
  return (
    <DemoCard
      cardRef={cardRef}
      eyebrow={<Trans>REAL FILES</Trans>}
      title={<Trans>Create</Trans>}
      body={<Trans>Reports, briefs and decks, ready to open, edit and share.</Trans>}
    >
      <DemoColumn>
        <div
          className={`min-h-[260px] rounded-[14px] bg-welcome-doc px-5 py-[18px] text-sm leading-[1.55] text-welcome-doc-ink ${fx(doc)}`}
        >
          <small className="font-mono text-[10px] tracking-[0.08em] text-welcome-pc-win-mute">
            <Trans>REPORT · PDF · CREATED NOW</Trans>
          </small>
          <h4 className="welcome-display mb-1 text-[22px] font-semibold tracking-[-0.02em]">
            <Trans>Q3 Client Review</Trans>
          </h4>
          <div className="welcome-caret [&>p]:mt-2.5">
            {typed.map((l) => (
              <p key={l}>{l}</p>
            ))}
          </div>
        </div>
      </DemoColumn>
    </DemoCard>
  );
}

export function AskCard({ active, cardRef }: CardProps) {
  const [card, setCard] = useState(false);
  const [press, setPress] = useState(false);
  const [sent, setSent] = useState(false);
  usePlayback(active, {
    reset: () => {
      setCard(false);
      setPress(false);
      setSent(false);
    },
    showAll: () => {
      setCard(true);
      setSent(true);
    },
    play: (later) => {
      later(200, () => setCard(true));
      later(1800, () => setPress(true));
      later(2050, () => {
        setPress(false);
        setSent(true);
      });
    },
  });
  const key =
    "rounded-[10px] p-2.5 text-center text-sm font-semibold transition-[transform,background-color]";
  return (
    <DemoCard
      cardRef={cardRef}
      eyebrow={<Trans>ASKS FIRST</Trans>}
      title={<Trans>Ask</Trans>}
      body={
        <Trans>
          Sending, paying, publishing: you say yes first. Everything else, it just does.
        </Trans>
      }
    >
      <DemoColumn>
        <div
          className={`grid gap-2.5 rounded-2xl border border-welcome-paper/12 bg-welcome-night-panel p-4 ${fx(card)}`}
        >
          <div className="flex items-center gap-2.5 text-[15px] font-semibold">
            <i className="grid size-7 place-items-center rounded-lg bg-welcome-night-amber text-welcome-amber-ink not-italic">
              ✉
            </i>
            <Trans>Send the follow-up to Maya?</Trans>
          </div>
          <p className="m-0 text-sm text-welcome-night-ink-2">
            <Trans>
              "Hi Maya, the one-page brief for Thursday is attached. The two open points are on
              top."
            </Trans>
          </p>
          <div className="grid grid-cols-2 gap-2">
            <span className={`${key} bg-welcome-night-key text-welcome-night-ink-2`}>
              <Trans>Not now</Trans>
            </span>
            <span
              className={`${key} bg-welcome-night-ink text-welcome-night ${press ? "scale-95" : ""}`}
            >
              <Trans>Send</Trans>
            </span>
          </div>
        </div>
        <div
          className={`flex items-center gap-2 text-sm font-semibold text-welcome-live ${fx(sent)}`}
        >
          <Trans>✓ Sent · 9:42 AM</Trans>
        </div>
      </DemoColumn>
    </DemoCard>
  );
}
