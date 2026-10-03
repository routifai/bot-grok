import type { Activity, ActivityStep, ThreadMessage, ThreadMessagePage } from "@aiden/contracts";
import { Button, cn, Dialog, DialogContent } from "@aiden/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { formatRelativeTime } from "../../../lib/relative-time";
import { isHelperActivity } from "./activityGrouping";
import { MessageRow } from "./SideChatSession";

/** The Activity run page's wire: full detail (Steps) and, for a Helper, its messages —
 * kept explicit (not the `rpc` client) so the dev fixture page can supply fakes. */
export type ActivityWire = {
  get: (input: { botId: string; activityId: string }) => Promise<Activity>;
  helperMessages: (input: { chatId: string }) => Promise<ThreadMessagePage>;
};

/** The run page's status dot: breathing (in progress), a quiet muted dot (done /
 * cancelled), or — the one allowed color — the destructive token on the dot alone when
 * failed. Nothing else on the run page carries status color (lead review: "remove
 * green/red"; the pill's container and label stay neutral). */
function RunStatusDot({ status }: { status: Activity["status"] }) {
  if (status === "in_progress") {
    return (
      <span aria-hidden="true" className="relative flex size-2 items-center justify-center">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-foreground/50 opacity-50 motion-reduce:animate-none" />
        <span className="relative size-1.5 rounded-full bg-foreground motion-safe:animate-[rkPulse_2.4s_ease-in-out_infinite]" />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-1.5 rounded-full",
        status === "failed" ? "bg-destructive" : "bg-muted-foreground/60",
      )}
    />
  );
}

function RunStatusPill({ status, label }: { status: Activity["status"]; label: string }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-[13px] font-medium text-muted-foreground">
      <RunStatusDot status={status} />
      {label}
    </span>
  );
}

/** One Step's dot on the Steps timeline: breathing only for the latest step of a run
 * still in progress (the motion is the signal, not a color); otherwise a quiet muted
 * dot, matching every other finished step. */
function StepDot({ live }: { live: boolean }) {
  return (
    <span
      aria-hidden="true"
      className="relative z-[1] mt-[3px] flex size-4 shrink-0 items-center justify-center"
    >
      {live ? (
        <span className="relative flex size-[9px] items-center justify-center">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-foreground/50 opacity-50 motion-reduce:animate-none" />
          <span className="relative size-[7px] rounded-full bg-foreground motion-safe:animate-[rkPulse_2.4s_ease-in-out_infinite]" />
        </span>
      ) : (
        <span className="size-1.5 rounded-full bg-muted-foreground/50" />
      )}
    </span>
  );
}

/** One Step on the timeline: a dot connected to its neighbors by a thin rule, a title
 * that wraps instead of truncating, and a time on the right. A Step with `detail` gets a
 * chevron in a fixed-width column before its title (native `<details>`, keyboard
 * reachable for free); a Step without one still reserves that column, so every title
 * starts at the same x whether or not its Step is expandable. */
function StepRow({ step, live, isLast }: { step: ActivityStep; live: boolean; isLast: boolean }) {
  const entries = step.detail ? Object.entries(step.detail) : [];
  const title = (
    <span
      className="min-w-0 flex-1 text-[13px] text-foreground"
      style={{ overflowWrap: "anywhere" }}
      dir="auto"
    >
      {step.title}
    </span>
  );
  const time = (
    <time className="shrink-0 pt-0.5 text-[11.5px] whitespace-nowrap text-muted-foreground">
      {formatRelativeTime(step.createdAt)}
    </time>
  );

  if (entries.length === 0) {
    return (
      <li className={cn("relative flex gap-3", !isLast && "pb-4")}>
        <StepDot live={live} />
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <span aria-hidden="true" className="w-4 shrink-0" />
          {title}
          {time}
        </div>
      </li>
    );
  }
  return (
    <li className={cn("relative flex gap-3", !isLast && "pb-4")}>
      <StepDot live={live} />
      <details className="group min-w-0 flex-1">
        <summary className="flex cursor-pointer list-none items-start gap-2 [&::-webkit-details-marker]:hidden">
          <span aria-hidden="true" className="flex w-4 shrink-0 items-center justify-center pt-0.5">
            <ChevronRight
              size={12}
              strokeWidth={2}
              className="text-muted-foreground transition-transform group-open:rotate-90"
            />
          </span>
          {title}
          {time}
        </summary>
        <dl className="mt-1.5 ml-6 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[12px]">
          {entries.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="text-muted-foreground/80">{key}</dt>
              <dd className="min-w-0 break-words text-foreground/80">{String(value)}</dd>
            </div>
          ))}
        </dl>
      </details>
    </li>
  );
}

/** The Steps timeline: one thin vertical rule behind every dot (same proportion as the
 * Goal plan timeline's — PlanTimeline.tsx), newest-last in the order the engine gives
 * them. */
function StepsTimeline({ steps, running }: { steps: ActivityStep[]; running: boolean }) {
  return (
    <ol className="relative mt-2" data-testid="activity-steps">
      <div aria-hidden="true" className="absolute top-2 bottom-2 left-2 w-px bg-border" />
      {steps.map((step, index) => {
        const isLast = index === steps.length - 1;
        return <StepRow key={step.itemId} step={step} live={running && isLast} isLast={isLast} />;
      })}
    </ol>
  );
}

/** A Helper's messages, read-only (CONTEXT.md "Helper": "Visible, read-only"): no
 * composer, one line saying so, reusing the Side Chat session's own bubble rendering. */
function HelperReadView({
  chatId,
  wire,
  onBack,
}: {
  chatId: string;
  wire: ActivityWire;
  onBack: () => void;
}) {
  const { t } = useLingui();
  const [messages, setMessages] = useState<ThreadMessage[] | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    setMessages(null);
    void wire
      .helperMessages({ chatId })
      .then((page) => {
        if (current === generation.current) setMessages(page.messages);
      })
      .catch(() => {
        if (current === generation.current) setMessages([]);
      });
    return () => {
      generation.current += 1;
    };
  }, [chatId, wire]);

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center border-b border-border px-6 py-2.5">
        <Button type="button" variant="ghost" size="xs" onClick={onBack}>
          {t`Back to steps`}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <p className="mb-4 rounded-xl bg-muted/60 px-3.5 py-2.5 text-[13px] text-muted-foreground">
          <Trans>This is a Helper's work — read-only.</Trans>
        </p>
        {messages === null ? (
          <p className="text-[13px] text-muted-foreground">{t`Loading…`}</p>
        ) : (
          <div className="flex flex-col gap-4">
            {messages.map((message) => (
              <MessageRow key={message.id} message={message} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The run page: a full-width header (status, title, time), then Outcome as a full-width
 * block with "Open helper" inline at its end, then Steps full-width below — the dialog
 * only earns a second column (Steps the wider ~60%) once it's wide enough to hold one
 * (≥900px) sensibly; a Helper Activity's "Open helper" replaces Outcome+Steps with its
 * read-only messages. Steps load lazily from `activities.get`, since `activities.list`
 * omits them.
 */
export function ActivityRunDialog({
  botId,
  wire,
  activity,
  onOpenChange,
}: {
  botId: string;
  wire: ActivityWire;
  /** The Activity to show, or null when the run page is closed. */
  activity: Activity | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useLingui();
  const [detail, setDetail] = useState<Activity | null>(null);
  const [helperOpen, setHelperOpen] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    setDetail(null);
    setHelperOpen(false);
    if (!activity) return;
    const current = ++generation.current;
    void wire
      .get({ botId, activityId: activity.id })
      .then((full) => {
        if (current === generation.current) setDetail(full);
      })
      .catch(() => undefined);
    return () => {
      generation.current += 1;
    };
  }, [botId, activity, wire]);

  if (!activity) return null;
  const steps = detail?.steps ?? [];
  const outcome =
    activity.outcome ?? (activity.status === "in_progress" ? t`Still working on this.` : null);
  const statusLabel = {
    in_progress: t`In progress`,
    done: t`Done`,
    failed: t`Didn't finish`,
    cancelled: t`Cancelled`,
  }[activity.status];
  const showHelper = helperOpen && isHelperActivity(activity);

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        className="grid max-h-[80vh] w-full max-w-[920px] grid-rows-[auto_1fr] gap-0 overflow-hidden p-0 sm:max-w-[920px]"
        aria-label={activity.title}
      >
        <div className="border-b border-border px-6 py-5 pe-12">
          <RunStatusPill status={activity.status} label={statusLabel} />
          <h3 className="mt-2.5 text-[18px] font-semibold text-foreground" dir="auto">
            {activity.title}
          </h3>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            {formatRelativeTime(activity.startedAt)}
          </p>
        </div>
        <div
          className={cn(
            "grid min-h-0",
            showHelper ? "grid-cols-1" : "grid-cols-1 min-[900px]:grid-cols-[1fr_1.6fr]",
          )}
        >
          {showHelper ? (
            <HelperReadView
              chatId={activity.chatId}
              wire={wire}
              onBack={() => setHelperOpen(false)}
            />
          ) : (
            <>
              <div className="border-b border-border px-6 py-5 min-[900px]:border-b-0 min-[900px]:border-e">
                <h4 className="text-[12.5px] font-semibold text-muted-foreground">{t`Outcome`}</h4>
                <div className="mt-1.5 flex items-start justify-between gap-4">
                  {outcome ? (
                    <p
                      className="min-w-0 flex-1 text-[15px] leading-[1.55] text-foreground"
                      dir="auto"
                    >
                      {outcome}
                    </p>
                  ) : (
                    <span className="flex-1" />
                  )}
                  {isHelperActivity(activity) ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="shrink-0"
                      onClick={() => setHelperOpen(true)}
                    >
                      {t`Open helper`}
                    </Button>
                  ) : null}
                </div>
              </div>
              <div className="min-h-0 overflow-y-auto px-6 py-5">
                <h4 className="text-[12.5px] font-semibold text-muted-foreground">{t`Steps`}</h4>
                {detail === null ? (
                  <p className="py-3 text-[13px] text-muted-foreground">{t`Loading…`}</p>
                ) : steps.length === 0 ? (
                  <p className="py-3 text-[13px] text-muted-foreground">{t`No steps recorded`}</p>
                ) : (
                  <StepsTimeline steps={steps} running={activity.status === "in_progress"} />
                )}
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
