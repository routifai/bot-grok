import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { Activity } from "@nova/contracts";
import { presentActivityTitle } from "@nova/core";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ActivityBranch, ActivityLine } from "../chrome/ActivityLine";
import { ActivityRunDialog } from "../chrome/ActivityRunDialog";
import { activityDurationMs, formatDuration, isRunning } from "../chrome/activityGrouping";
import {
  type ActivityNode,
  buildActivityForest,
  findHelperNode,
  isNodeRunning,
  latestStepTitle,
  stepCount,
} from "../chrome/activityTree";
import { activityFeedFor, LIVE_ACTIVITY_WIRE } from "../chrome/useActivities";
import { useNow } from "../chrome/useNow";

function findActivity(node: ActivityNode, id: string): Activity | undefined {
  if (node.activity.id === id) return node.activity;
  for (const child of node.children) {
    const found = findActivity(child, id);
    if (found) return found;
  }
  return undefined;
}

/** One Helper (or one part of its task) as the inline "Working" line (ActivityLine): a tiny orb
 * while it works, its title, its step count and time in mono, and "Now · <live step>" underneath while it works.
 * Reads the same Activity the panel row shows; opening it opens the same run page. */
function HelperLine({
  activity,
  fallbackTitle,
  nested,
  now,
  onOpen,
}: {
  activity: Activity | undefined;
  fallbackTitle: string;
  nested: boolean;
  now: number;
  onOpen?: () => void;
}) {
  const { t } = useLingui();
  if (!activity) return <ActivityLine variant="inline" title={fallbackTitle} nested={nested} />;
  const steps = stepCount(activity);
  const duration = activityDurationMs(activity, now);
  const meta = [
    steps > 0 ? plural(steps, { one: "# step", other: "# steps" }) : null,
    duration !== null ? formatDuration(duration) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <ActivityLine
      variant="inline"
      status={activity.status}
      source={activity.source}
      title={presentActivityTitle(activity.title)}
      meta={meta || undefined}
      liveStep={isRunning(activity) ? (latestStepTitle(activity) ?? t`Starting`) : undefined}
      detail={
        activity.status === "failed"
          ? t`Didn't finish`
          : activity.status === "cancelled"
            ? t`Cancelled`
            : undefined
      }
      nested={nested}
      onClick={onOpen}
      testId="helper-tracker-row"
    />
  );
}

function HelperTree({
  node,
  nested,
  now,
  onOpen,
}: {
  node: ActivityNode;
  nested: boolean;
  now: number;
  onOpen: (activityId: string) => void;
}) {
  return (
    <div className="flex flex-col items-start">
      <HelperLine
        activity={node.activity}
        fallbackTitle=""
        nested={nested}
        now={now}
        onOpen={() => onOpen(node.activity.id)}
      />
      {node.children.length > 0 ? (
        <ActivityBranch variant="inline">
          {node.children.map((child) => (
            <HelperTree key={child.activity.id} node={child} nested now={now} onOpen={onOpen} />
          ))}
        </ActivityBranch>
      ) : null}
    </div>
  );
}

/**
 * The live row under a Muse's hand-off message for one Helper it started: the same Activity the
 * panel lists (one shared feed, useActivities.ts), so it shows working the moment the Helper
 * starts, counts its steps, settles to done in place when the result lands, and nests the parts
 * a Helper hands on. Clicking opens that Activity's run page. Until the feed has the Helper
 * (the engine's signal makes that a moment) the row shows its title, plainly.
 */
export function HelperTracker({
  botId,
  helperId,
  title,
}: {
  botId: string;
  helperId: string;
  title: string;
}) {
  const feed = activityFeedFor(botId);
  const { state } = useSyncExternalStore(feed.subscribe, feed.getSnapshot);
  const node = useMemo(
    () =>
      state.status === "ready"
        ? findHelperNode(buildActivityForest(state.activities), helperId)
        : undefined,
    [state, helperId],
  );
  const [openId, setOpenId] = useState<string | null>(null);
  const now = useNow(node ? isNodeRunning(node) : false);
  // A Helper the feed has not listed yet (it may have started a moment ago): ask once more.
  useEffect(() => {
    if (state.status === "ready" && !node) feed.refresh();
  }, [feed, state.status, node]);

  const open = node && openId ? findActivity(node, openId) : undefined;
  return (
    <div className="flex max-w-full flex-col items-start" data-testid="helper-tracker">
      {node ? (
        <HelperTree node={node} nested={false} now={now} onOpen={setOpenId} />
      ) : (
        <HelperLine activity={undefined} fallbackTitle={title} nested={false} now={now} />
      )}
      <ActivityRunDialog
        botId={botId}
        wire={LIVE_ACTIVITY_WIRE}
        activity={open ?? null}
        onOpenChange={(next) => {
          if (!next) setOpenId(null);
        }}
      />
    </div>
  );
}
