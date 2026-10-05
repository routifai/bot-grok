import type { Activity } from "@aiden/contracts";
import { presentActivityTitle } from "@aiden/core";
import { cn } from "@aiden/ui-web";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Shimmer } from "../../../components/ai/primitives";
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
import { RunStatusDot } from "../chrome/RunStatusDot";
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

/** One Helper (or one part of its task) as a single quiet line: a status dot, its title, and
 * "6 steps · 1m 20s" once it has them. While it works, its live Step shimmers underneath. Reads
 * the same Activity the panel row shows; opening it opens the same run page. */
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
  const title = activity ? presentActivityTitle(activity.title) : fallbackTitle;
  const live = activity ? isRunning(activity) : false;
  const steps = activity ? stepCount(activity) : 0;
  const duration = activity ? activityDurationMs(activity, now) : null;
  const facts = [
    steps > 0 ? plural(steps, { one: "# step", other: "# steps" }) : null,
    activity?.status === "failed" ? t`Didn't finish` : null,
    activity?.status === "cancelled" ? t`Cancelled` : null,
    duration !== null ? formatDuration(duration) : null,
  ].filter(Boolean);
  const liveStep = live ? (latestStepTitle(activity as Activity) ?? t`Starting`) : undefined;
  const body = (
    <>
      <span className="flex h-[1.4em] shrink-0 items-center">
        {activity ? (
          <RunStatusDot status={activity.status} />
        ) : (
          <span aria-hidden="true" className="size-1.5 rounded-full bg-muted-foreground/40" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate" dir="auto">
          <span className={cn("font-medium text-foreground", nested && "font-normal")}>
            {title}
          </span>
          {facts.length > 0 ? (
            <span className="text-muted-foreground tabular-nums"> · {facts.join(" · ")}</span>
          ) : null}
        </span>
        {liveStep ? (
          <span className="block truncate text-[12.5px]" aria-live="polite" dir="auto">
            <Shimmer>{liveStep}</Shimmer>
          </span>
        ) : null}
      </span>
    </>
  );
  const className = cn(
    "flex w-full items-start gap-2.5 rounded-lg px-2 py-1 text-start text-[13.5px] leading-[1.4]",
    nested && "text-[13px]",
  );
  if (!activity || !onOpen) return <div className={className}>{body}</div>;
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="helper-tracker-row"
      data-status={activity.status}
      className={cn(
        className,
        "transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring",
      )}
    >
      {body}
    </button>
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
    <div className="flex flex-col">
      <HelperLine
        activity={node.activity}
        fallbackTitle=""
        nested={nested}
        now={now}
        onOpen={() => onOpen(node.activity.id)}
      />
      {node.children.length > 0 ? (
        <div className="ms-3.5 flex flex-col border-s border-border ps-1">
          {node.children.map((child) => (
            <HelperTree key={child.activity.id} node={child} nested now={now} onOpen={onOpen} />
          ))}
        </div>
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
    <div className="flex w-[min(420px,90%)] flex-col" data-testid="helper-tracker">
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
