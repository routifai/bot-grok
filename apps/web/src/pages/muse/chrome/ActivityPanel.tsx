import type { Activity, ActivityStatus } from "@aiden/contracts";
import { presentActivityTitle, presentStep } from "@aiden/core";
import { Button, cn } from "@aiden/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { formatRelativeTime } from "../../../lib/relative-time";
import { ActivityRunDialog, type ActivityWire } from "./ActivityRunDialog";
import {
  activityLineText,
  activityStatusMark,
  groupActivitiesByDate,
  isHelperActivity,
} from "./activityGrouping";
import { PanelRowSkeletonList } from "./PanelSkeleton";
import { TOOL_ICON_COMPONENT } from "./toolIcons";
import type { ActivitiesState } from "./useActivities";

/** The breathing dot / check / mark / muted dash on an Activity's line
 * (docs/super-chat/README.md "The Activity panel"). Shape carries the status, not color —
 * the app stays monochrome here too, only the live dot's motion is the signal. Every mark
 * sits in the same fixed-size box so every row's title starts at the same x regardless of
 * which mark it has. The live dot's pulse is `motion-safe` so reduced motion shows it still. */
function ActivityMark({ status }: { status: ActivityStatus }) {
  const mark = activityStatusMark(status);
  return (
    <span
      aria-hidden="true"
      className="mt-0.5 flex size-4 shrink-0 items-center justify-center self-start"
    >
      {mark === "live" ? (
        <span className="relative flex size-[9px] items-center justify-center">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-foreground/60 opacity-50 motion-reduce:animate-none" />
          <span className="relative size-[7px] rounded-full bg-foreground motion-safe:animate-[rkPulse_2.4s_ease-in-out_infinite]" />
        </span>
      ) : mark === "done" ? (
        <svg viewBox="0 0 24 24" width={13} height={13} fill="none">
          <path
            d="M5 12l5 5 9-10"
            stroke="currentColor"
            strokeWidth={2.25}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-muted-foreground"
          />
        </svg>
      ) : mark === "failed" ? (
        <svg viewBox="0 0 24 24" width={10} height={10} fill="none">
          <path
            d="M6 6l12 12M18 6 6 18"
            stroke="currentColor"
            strokeWidth={2.25}
            strokeLinecap="round"
            className="text-foreground"
          />
        </svg>
      ) : (
        <span className="block h-px w-2.5 rounded-full bg-muted-foreground/60" />
      )}
    </span>
  );
}

function ActivityRow({ activity, onOpen }: { activity: Activity; onOpen: () => void }) {
  const { t } = useLingui();
  const live = activity.status === "in_progress";
  const line = activityLineText(activity, {
    in_progress: t`Working`,
    done: t`Done`,
    failed: t`Didn't finish`,
    cancelled: t`Cancelled`,
  });
  // While in progress, the latest Step's icon + plain-language title (never its raw tool
  // name) stands in for the plain status/outcome line, when the engine has sent one yet.
  const latestStep = live ? activity.steps?.at(-1) : undefined;
  const presented = latestStep ? presentStep(latestStep) : null;
  const StepIcon = presented ? TOOL_ICON_COMPONENT[presented.icon] : null;
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="activity-row"
      className="flex w-full items-start gap-3 rounded-xl px-2.5 py-2 text-start transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
    >
      <ActivityMark status={activity.status} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-[14px] font-medium text-foreground" dir="auto">
            {presentActivityTitle(activity.title)}
          </span>
          {isHelperActivity(activity) ? (
            <span className="shrink-0 rounded-full bg-muted px-1.5 py-[1px] text-[10.5px] font-medium text-muted-foreground">
              <Trans>Background</Trans>
            </span>
          ) : null}
        </span>
        <span
          className={cn(
            "flex min-w-0 items-center gap-1 text-[13px]",
            live && "text-foreground/80",
            activity.status === "failed" && "text-foreground",
            !live && activity.status !== "failed" && "text-muted-foreground",
          )}
          aria-live={live ? "polite" : undefined}
        >
          {StepIcon ? (
            <StepIcon
              size={12}
              strokeWidth={2}
              className="shrink-0 text-muted-foreground/70"
              aria-hidden="true"
            />
          ) : null}
          <span className="truncate">{presented ? presented.title : line}</span>
        </span>
      </span>
      <time className="shrink-0 pt-0.5 text-[12px] whitespace-nowrap text-muted-foreground">
        {formatRelativeTime(activity.startedAt)}
      </time>
    </button>
  );
}

/** The same calm line, whichever of "truly nothing yet" or "this Muse has no
 * Conversation yet" (NOT_FOUND) it's for — both read the same to the person. */
function EmptyActivities() {
  const { t } = useLingui();
  return (
    <p
      className="py-8 text-center text-[13.5px] text-muted-foreground"
      data-testid="activity-empty"
    >
      {t`Nothing yet — once I do something, it shows up here.`}
    </p>
  );
}

/**
 * The Activity panel's ledger (docs/super-chat/README.md "The Activity panel"): a quiet
 * log beside the Conversation, one calm line per piece of work, grouped by day, newest
 * first. Opening a line opens the run page (ActivityRunDialog), which is kept resynced
 * to this same list by id, so it never shows a stale snapshot while the poll updates
 * the row behind it.
 */
export function ActivityPanel({
  botId,
  wire,
  state,
  loadEarlier,
  loadingEarlier,
}: {
  botId: string;
  wire: ActivityWire;
  state: ActivitiesState;
  loadEarlier: () => Promise<void>;
  loadingEarlier: boolean;
}) {
  const { t, i18n } = useLingui();
  const [openActivityId, setOpenActivityId] = useState<string | null>(null);

  // Both read as "nothing to show yet" — a brand new Muse with no Conversation
  // (NOT_FOUND) looks the same here as a feature not wired up in this environment
  // (NOT_IMPLEMENTED); neither is an error.
  if (state.status === "unavailable") return <EmptyActivities />;
  if (state.status === "loading") return <PanelRowSkeletonList count={4} />;
  if (state.status === "error") {
    return <p className="text-[13px] text-destructive">{t`Could not load Activity`}</p>;
  }

  const groups = groupActivitiesByDate(state.activities, new Date(), i18n.locale);
  // Resynced by id every render, not the clicked snapshot — so the run page reflects
  // whatever the latest poll merged into `state.activities` (useActivities.ts).
  const openActivity =
    (openActivityId && state.activities.find((activity) => activity.id === openActivityId)) || null;

  if (groups.length === 0) {
    return <EmptyActivities />;
  }

  return (
    <div className="flex flex-col gap-4" data-testid="activity-panel">
      {groups.map((group) => (
        <section key={group.date} className="flex flex-col gap-1">
          <h3 className="px-1 text-[12.5px] font-semibold text-muted-foreground">
            {group.label.kind === "today"
              ? t`Today`
              : group.label.kind === "yesterday"
                ? t`Yesterday`
                : group.label.text}
          </h3>
          <div className="flex flex-col gap-0.5">
            {group.activities.map((activity) => (
              <ActivityRow
                key={activity.id}
                activity={activity}
                onOpen={() => setOpenActivityId(activity.id)}
              />
            ))}
          </div>
        </section>
      ))}
      {state.hasMore ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start text-muted-foreground"
          disabled={loadingEarlier}
          onClick={() => void loadEarlier()}
        >
          {loadingEarlier ? t`Loading…` : t`Load earlier`}
        </Button>
      ) : null}
      <ActivityRunDialog
        botId={botId}
        wire={wire}
        activity={openActivity}
        onOpenChange={(open) => {
          if (!open) setOpenActivityId(null);
        }}
      />
    </div>
  );
}
