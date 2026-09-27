import { cn } from "@aiden/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { Check } from "lucide-react";
import type { IllustrationKey } from "../../../lib/illustrations";
import { illustrationUrl } from "../../../lib/illustrations";
import { MUSE_TYPE, MuseColumn } from "../ui";

type StepState = "done" | "working" | "next";

function Ring({ value, color }: { value: number; color: string }) {
  const radius = 17;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg viewBox="0 0 40 40" className="size-11 shrink-0 -rotate-90" aria-hidden="true">
      <circle cx="20" cy="20" r={radius} fill="none" strokeWidth="3.5" className="stroke-muted" />
      <circle
        cx="20"
        cy="20"
        r={radius}
        fill="none"
        strokeWidth="3.5"
        strokeLinecap="round"
        stroke={color}
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - value)}
      />
    </svg>
  );
}

function Step({ state, children }: { state: StepState; children: string }) {
  return (
    <li className="flex items-center gap-3 py-1.5">
      <span
        aria-hidden="true"
        className={cn(
          "grid size-5 shrink-0 place-items-center rounded-full border",
          state === "done" && "border-transparent bg-foreground text-background",
          state === "working" && "border-foreground",
          state === "next" && "border-border",
        )}
      >
        {state === "done" ? <Check size={12} strokeWidth={3} /> : null}
        {state === "working" ? (
          <span className="size-2 rounded-full bg-foreground motion-safe:animate-pulse" />
        ) : null}
      </span>
      <span
        className={cn(
          "text-[15px]",
          state === "done" ? "text-muted-foreground" : "text-foreground",
          state === "working" && "font-medium",
        )}
      >
        {children}
      </span>
    </li>
  );
}

/** What a Goal looks like once it exists: the plan, progress, and the next check-in. */
function ExampleGoal({ color }: { color: string }) {
  const { t } = useLingui();
  return (
    <div className="relative rounded-2xl border border-border bg-card p-5 shadow-sm">
      <span className="absolute top-4 right-4 rounded-full bg-muted px-2 py-0.5 text-[12px] text-muted-foreground">
        <Trans>Example</Trans>
      </span>
      <div className="flex items-center gap-4 pe-16">
        <Ring value={0.4} color={color} />
        <div className="min-w-0">
          <p className={MUSE_TYPE.cardTitle}>
            <Trans>Q3 client portfolio review</Trans>
          </p>
          <p className="mt-0.5 text-[13.5px] text-muted-foreground">
            <Trans>2 of 5 steps · Next check-in Friday, 9:00</Trans>
          </p>
        </div>
      </div>
      <ul className="mt-4 border-t border-border pt-3">
        <Step state="done">{t`Pull holdings and returns for 12 clients`}</Step>
        <Step state="done">{t`Flag drift from each target mix`}</Step>
        <Step state="working">{t`Draft talking points per client`}</Step>
        <Step state="next">{t`Propose meeting slots`}</Step>
        <Step state="next">{t`Send prep packs the day before`}</Step>
      </ul>
    </div>
  );
}

export interface GoalStarter {
  illustration: IllustrationKey;
  title: string;
  detail: string;
  /** What gets sent to the Conversation. */
  prompt: string;
}

/**
 * The Goals page before the first Goal: it shows what a Goal is (an example with a
 * plan, progress and a check-in) and offers a few concrete starters, each of which
 * opens the Conversation with that ask.
 */
export function GoalsIntro({
  botName,
  avatarColor,
  starters,
  onStart,
}: {
  botName: string;
  avatarColor: string;
  starters: readonly GoalStarter[];
  onStart?: (prompt: string) => void;
}) {
  return (
    <MuseColumn className="flex min-h-full flex-col pt-14 pb-12">
      <header className="pb-8">
        <h1 className={MUSE_TYPE.pageTitle}>
          <Trans>Goals</Trans>
        </h1>
        <p className={cn("mt-2", MUSE_TYPE.pageSubtitle)}>
          <Trans>
            Give {botName} something bigger than a message. I'll plan it, work on it in the
            background, and check in with you.
          </Trans>
        </p>
      </header>

      <ExampleGoal color={avatarColor} />

      {onStart && starters.length > 0 ? (
        <section className="pt-10">
          <h2 className="pb-1 text-[17px] font-semibold text-foreground">
            <Trans>Start with one of these</Trans>
          </h2>
          <ul className="flex flex-col">
            {starters.map((starter) => (
              <li key={starter.title}>
                <button
                  type="button"
                  onClick={() => onStart(starter.prompt)}
                  className="-mx-4 flex w-[calc(100%+2rem)] items-start gap-4 rounded-2xl px-4 py-3.5 text-start transition-colors hover:bg-accent/60 focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <img
                    src={illustrationUrl(starter.illustration)}
                    alt=""
                    loading="lazy"
                    className="mt-0.5 size-9 shrink-0"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[16px] font-medium leading-snug text-foreground">
                      {starter.title}
                    </span>
                    <span className="mt-1 block text-[15px] leading-[1.5] text-muted-foreground">
                      {starter.detail}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </MuseColumn>
  );
}
