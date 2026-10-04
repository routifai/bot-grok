import type { Activity } from "@aiden/contracts";
import { presentActivityTitle, presentStep } from "@aiden/core";
import { Button, cn } from "@aiden/ui-web";
import { useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { ActivityIconTile } from "./ActivityIconTile";
import { ActivityRunDialog, type ActivityWire } from "./ActivityRunDialog";
import { activityLineText, formatClockTime, groupActivitiesByDate } from "./activityGrouping";
import { PanelRowSkeletonList } from "./PanelSkeleton";
import { ACTIVITY_SOURCE_ICON } from "./toolIcons";
import type { ActivitiesState } from "./useActivities";

/** One Activity: an icon tile for where it came from, a short task title, one calm line
 * under it (the live Step while working, the outcome's gist when done), and the clock
 * time. Status is the line's words and the tile's own motion/tint, not a separate mark —
 * the app stays monochrome here, only a failed run's tile takes the destructive token. */
function ActivityRow({ activity, onOpen }: { activity: Activity; onOpen: () => void }) {
  const { t, i18n } = useLingui();
  const live = activity.status === "in_progress";
  const failed = activity.status === "failed";
  const line = activityLineText(activity, {
    in_progress: t`Working`,
    done: t`Done`,
    failed: t`Didn't finish`,
    cancelled: t`Cancelled`,
  });
  // While in progress, the latest Step's plain-language title (never its raw tool name)
  // stands in for the summary line, when the engine has sent one yet.
  const latestStep = live ? activity.steps?.at(-1) : undefined;
  const Icon = ACTIVITY_SOURCE_ICON[activity.source];
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="activity-row"
      className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-start transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
    >
      <ActivityIconTile Icon={Icon} live={live} failed={failed} />
      <span className="min-w-0 flex-1">
        <span className="block min-w-0 truncate text-[14px] font-medium text-foreground" dir="auto">
          {presentActivityTitle(activity.title)}
        </span>
        <span
          className={cn(
            "block min-w-0 truncate text-[13px]",
            live ? "text-foreground/80" : "text-muted-foreground",
            failed && "text-foreground",
          )}
          aria-live={live ? "polite" : undefined}
          dir="auto"
        >
          {latestStep ? presentStep(latestStep).title : line}
        </span>
      </span>
      <time
        className="shrink-0 text-[12px] whitespace-nowrap text-muted-foreground"
        dateTime={activity.startedAt}
      >
        {formatClockTime(activity.startedAt, i18n.locale)}
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
