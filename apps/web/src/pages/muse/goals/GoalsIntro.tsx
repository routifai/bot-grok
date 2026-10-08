import { BotAvatar, cn } from "@aiden/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { ArrowUp, ChevronRight } from "lucide-react";
import { useState } from "react";
import type { IllustrationKey } from "../../../lib/illustrations";
import { illustrationUrl } from "../../../lib/illustrations";
import { MUSE_TYPE, MuseColumn } from "../ui";
import { GoalRing, GoalStep } from "./visuals";

// iOS-flavoured press feedback: a quick, springy scale on press.
const PRESS =
  "transition-transform duration-150 ease-out active:scale-[0.98] motion-reduce:active:scale-100";

/**
 * A Goal in motion, shown rather than explained: the Goal as a widget (progress, plan,
 * next check-in) and, under it, the kind of check-in banner the Muse sends —
 * which is also how an Ask looks when it needs a decision. Both stack, never overlap.
 */
function GoalStage({ botName, color }: { botName: string; color: string }) {
  const { t } = useLingui();
  return (
    <div className="flex flex-col gap-4 rounded-[28px] bg-muted/60 p-5 sm:p-8">
      {/* Sample content: labelled so it is never read as one of the person's Goals. */}
      <span className="w-fit rounded-full border border-border bg-card px-3 py-1 text-[13px] font-medium text-foreground">
        <Trans>Example</Trans>
      </span>
      <div aria-hidden="true" className="flex flex-col gap-4">
        <div className="rounded-[22px] bg-card p-5 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_12px_32px_-12px_rgb(0_0_0/0.18)]">
          <div className="flex items-center gap-4">
            <GoalRing value={0.4} color={color} />
            <div className="min-w-0 flex-1">
              <p className="text-[17px] font-semibold tracking-[-0.02em] text-foreground">
                <Trans>Q3 client portfolio review</Trans>
              </p>
              <p className="mt-0.5 text-[13.5px] text-muted-foreground">
                <Trans>2 of 5 · Next check-in Friday, 9:00</Trans>
              </p>
            </div>
          </div>
          <ul className="mt-4 border-t border-border/70 pt-2">
            <GoalStep state="done">{t`Pull holdings and returns for 12 clients`}</GoalStep>
            <GoalStep state="done">{t`Flag drift from each target mix`}</GoalStep>
            <GoalStep state="working">{t`Draft talking points per client`}</GoalStep>
            <GoalStep state="next">{t`Propose meeting slots`}</GoalStep>
          </ul>
        </div>

        <div className="sm:ms-auto sm:w-[380px]">
          <div className="rounded-[22px] border border-line bg-panel p-3.5 shadow-[0_18px_40px_-16px_rgb(0_0_0/0.28)] backdrop-blur-2xl">
            <div className="flex items-start gap-3">
              <span className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-[10px] bg-card shadow-sm">
                <BotAvatar color={color} identity={botName} face="muse" size={30} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[13px] font-semibold text-foreground">{botName}</span>
                  <span className="text-[12px] text-muted-foreground">
                    <Trans>Fri 9:00</Trans>
                  </span>
                </div>
                <p className="mt-0.5 text-[14px] leading-[1.4] text-foreground">
                  <Trans>
                    Talking points are ready for 5 of 12 clients. Two drifted more than 8% from
                    target. Want me to propose meeting slots?
                  </Trans>
                </p>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <span className="rounded-full bg-foreground py-2 text-center text-[13.5px] font-medium text-background">
                <Trans>Yes, go ahead</Trans>
              </span>
              <span className="rounded-full bg-muted py-2 text-center text-[13.5px] font-medium text-foreground">
                <Trans>Not yet</Trans>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function GoalComposer({
  botName,
  color,
  onStart,
}: {
  botName: string;
  color: string;
  onStart: (text: string) => void;
}) {
  const { t } = useLingui();
  const [text, setText] = useState("");
  const ready = text.trim().length > 0;
  return (
    <form
      className="flex h-14 items-center gap-3 rounded-full bg-card ps-2.5 pe-2 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-12px_rgb(0_0_0/0.16)] ring-1 ring-border/70 focus-within:ring-2 focus-within:ring-ring"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) onStart(text.trim());
      }}
    >
      <BotAvatar color={color} identity={botName} face="muse" size={34} />
      <input
        value={text}
        onChange={(event) => setText(event.target.value)}
        aria-label={t`Describe a Goal`}
        placeholder={t`What do you want to get done?`}
        className="min-w-0 flex-1 bg-transparent text-[16px] tracking-[-0.01em] text-foreground outline-none placeholder:text-muted-foreground"
      />
      <button
        type="submit"
        aria-label={t`Start this Goal`}
        disabled={!ready}
        className={cn(
          "grid size-10 shrink-0 place-items-center rounded-full bg-foreground text-background transition-opacity disabled:opacity-25",
          PRESS,
        )}
      >
        <ArrowUp size={18} strokeWidth={2.25} />
      </button>
    </form>
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
 * The Goals page before the first Goal, in an iOS spirit: a large title, a composer to
 * say the Goal right here, a Goal in motion (widget plus check-in banner) instead of an
 * explanation, and a grouped list of starters.
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
    <MuseColumn className="flex min-h-full flex-col gap-10 pt-14 pb-16">
      <header>
        <h1 className={MUSE_TYPE.pageTitle}>
          <Trans>Goals</Trans>
        </h1>
        <p className="mt-2 max-w-[560px] text-[17px] leading-[1.45] tracking-[-0.01em] text-muted-foreground">
          <Trans>
            Give {botName} something bigger than a message. I'll plan it, keep working on it, and
            check in with you.
          </Trans>
        </p>
        {onStart ? (
          <div className="mt-6">
            <GoalComposer botName={botName} color={avatarColor} onStart={onStart} />
          </div>
        ) : null}
      </header>

      <GoalStage botName={botName} color={avatarColor} />

      {onStart && starters.length > 0 ? (
        <section className="pt-4">
          <h2 className="px-1 pb-2.5 text-[15px] font-medium text-muted-foreground">
            <Trans>Try one</Trans>
          </h2>
          <ul className="overflow-hidden rounded-[22px] bg-card shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-14px_rgb(0_0_0/0.14)] ring-1 ring-border/60">
            {starters.map((starter, index) => (
              <li key={starter.title}>
                <button
                  type="button"
                  onClick={() => onStart(starter.prompt)}
                  className="group flex w-full items-center gap-4 px-4 text-start transition-colors hover:bg-accent/50 focus-visible:bg-accent/60 focus-visible:outline-none active:bg-accent"
                >
                  <img
                    src={illustrationUrl(starter.illustration)}
                    alt=""
                    loading="lazy"
                    className="size-10 shrink-0"
                  />
                  <span
                    className={cn(
                      "flex min-w-0 flex-1 items-center gap-3 py-3.5",
                      index > 0 && "border-t border-border/70",
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-[16px] font-medium tracking-[-0.01em] text-foreground">
                        {starter.title}
                      </span>
                      <span className="mt-0.5 block text-[14px] leading-[1.45] text-muted-foreground">
                        {starter.detail}
                      </span>
                    </span>
                    <ChevronRight
                      size={18}
                      strokeWidth={2}
                      aria-hidden="true"
                      className="shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5"
                    />
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
