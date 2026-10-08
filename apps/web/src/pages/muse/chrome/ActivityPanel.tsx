import type { Activity } from "@aiden/contracts";
import { presentActivityTitle } from "@aiden/core";
import { Button, cn } from "@aiden/ui-web";
import { useLingui } from "@lingui/react/macro";
import { useMemo, useState } from "react";
import { Shimmer } from "../../../components/ai/primitives";
import { ActivityIconTile } from "./ActivityIconTile";
import { ActivityRunDialog, type ActivityWire } from "./ActivityRunDialog";
import {
  activityDurationMs,
  activityLineText,
  formatClockTime,
  formatDuration,
  groupActivitiesByDate,
  isRunning,
} from "./activityGrouping";
import {
  type ActivityNode,
  buildActivityForest,
  isNodeRunning,
  latestStepTitle,
} from "./activityTree";
import { PanelRowSkeletonList } from "./PanelSkeleton";
import { ACTIVITY_SOURCE_ICON } from "./toolIcons";
import type { ActivitiesState } from "./useActivities";
import { useNow } from "./useNow";

/** One Activity: an icon tile for where it came from, a short task title, one calm line
 * under it, and a time. Working, the line is the live Step (shimmering) and the time is how
 * long it has been going; settled, the line is the outcome's gist and the time is the clock.
 * Status is the line's words and the tile's own motion/tint, not a separate mark — the app
 * stays monochrome here, only a failed run's tile takes the destructive token. A Helper's
 * parts nest beneath it as smaller rows of the same kind. */
function ActivityRow({
  node,
  depth = 0,
  now,
  onOpen,
}: {
  node: ActivityNode;
  depth?: number;
  now: number;
  onOpen: (activityId: string) => void;
}) {
  const { activity, children } = node;
  const { t, i18n } = useLingui();
  const live = isRunning(activity);
  const failed = activity.status === "failed";
  const line = activityLineText(activity, {
    in_progress: t`Working`,
    done: t`Done`,
    failed: t`Didn't finish`,
    cancelled: t`Cancelled`,
  });
  const liveLine = live ? (latestStepTitle(activity) ?? t`Starting`) : undefined;
  const duration = live ? activityDurationMs(activity, now) : null;
  const Icon = ACTIVITY_SOURCE_ICON[activity.source];
  const nested = depth > 0;
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => onOpen(activity.id)}
        data-testid="activity-row"
        data-status={activity.status}
        className={cn(
          "flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-start transition-colors hover:bg-selection focus-visible:outline-2 focus-visible:outline-ring",
          nested && "py-1.5",
        )}
      >
        <ActivityIconTile Icon={Icon} live={live} failed={failed} size={nested ? "sm" : "md"} />
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block min-w-0 truncate font-medium text-foreground",
              nested ? "text-[13px]" : "text-[13.5px]",
            )}
            dir="auto"
          >
            {presentActivityTitle(activity.title)}
          </span>
          <span
            className={cn(
              "block min-w-0 truncate text-[12.5px]",
              live ? "text-ink-2" : "text-ink-3",
              failed && "text-foreground",
            )}
            aria-live={live ? "polite" : undefined}
            dir="auto"
          >
            {liveLine ? <Shimmer>{liveLine}</Shimmer> : line}
          </span>
        </span>
        {live ? (
          <span
            className="shrink-0 font-mono text-[11.5px] whitespace-nowrap text-ink-3 tabular-nums"
            data-testid="activity-elapsed"
          >
            {duration === null ? "" : formatDuration(duration)}
          </span>
        ) : (
          <time
            className="shrink-0 font-mono text-[11.5px] whitespace-nowrap text-ink-3 tabular-nums"
            dateTime={activity.startedAt}
          >
            {formatClockTime(activity.startedAt, i18n.locale)}
          </time>
        )}
      </button>
      {children.length > 0 ? (
        <div className="ms-[22px] flex flex-col border-s border-line ps-1.5">
          {children.map((child) => (
            <ActivityRow
              key={child.activity.id}
              node={child}
              depth={depth + 1}
              now={now}
              onOpen={onOpen}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

const EMPTY_ACTIVITIES: Activity[] = [];

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
  const activities = state.status === "ready" ? state.activities : EMPTY_ACTIVITIES;
  // Helpers nest under the Helper that started them; whatever is running sits above the days.
  const { working, groups, nodeByActivityId } = useMemo(() => {
    const forest = buildActivityForest(activities);
    const byId = new Map<string, ActivityNode>();
    const index = (node: ActivityNode) => {
      byId.set(node.activity.id, node);
      node.children.forEach(index);
    };
    forest.forEach(index);
    return {
      working: forest.filter(isNodeRunning),
      groups: groupActivitiesByDate(
        forest.filter((node) => !isNodeRunning(node)).map((node) => node.activity),
        new Date(),
        i18n.locale,
      ),
      nodeByActivityId: byId,
    };
  }, [activities, i18n.locale]);
  const now = useNow(working.length > 0);

  // Both read as "nothing to show yet" — a brand new Muse with no Conversation
  // (NOT_FOUND) looks the same here as a feature not wired up in this environment
  // (NOT_IMPLEMENTED); neither is an error.
  if (state.status === "unavailable") return <EmptyActivities />;
  if (state.status === "loading") return <PanelRowSkeletonList count={4} />;
  if (state.status === "error") {
    return <p className="text-[13px] text-destructive">{t`Could not load Activity`}</p>;
  }

  // Resynced by id every render, not the clicked snapshot — so the run page reflects
  // whatever the latest read merged into `state.activities` (activityFeed.ts).
  const openActivity = (openActivityId && nodeByActivityId.get(openActivityId)?.activity) || null;

  if (working.length === 0 && groups.length === 0) {
    return <EmptyActivities />;
  }

  return (
    <div className="flex flex-col gap-4" data-testid="activity-panel">
      {working.length > 0 ? (
        <section className="flex flex-col gap-1" data-testid="activity-working">
          <h3 className="px-1 text-[12px] font-semibold text-ink-3">{t`Working now`}</h3>
          <div className="flex flex-col gap-0.5">
            {working.map((node) => (
              <ActivityRow
                key={node.activity.id}
                node={node}
                now={now}
                onOpen={setOpenActivityId}
              />
            ))}
          </div>
        </section>
      ) : null}
      {groups.map((group) => (
        <section key={group.date} className="flex flex-col gap-1">
          <h3 className="px-1 text-[12px] font-semibold text-ink-3">
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
                node={nodeByActivityId.get(activity.id) ?? { activity, children: [] }}
                now={now}
                onOpen={setOpenActivityId}
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
