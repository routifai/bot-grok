import { useLingui } from "@lingui/react/macro";
import type { Activity } from "@nova/contracts";
import { presentActivityTitle } from "@nova/core";
import { Button } from "@nova/ui-web";
import { useEffect, useMemo, useState } from "react";
import { ActivityBranch, ActivityLine } from "./ActivityLine";
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
import type { ActivitiesState } from "./useActivities";
import { useNow } from "./useNow";

/** One Activity as the "Working" line (ActivityLine): a status dot, its title, and a mono
 * figure on the right. Working, the line under the title is "Now · <live step>" and the figure
 * is how long it has gone; settled, the line is the outcome's gist and the figure is the clock.
 * A Helper's parts hang beneath it on a connector line. */
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
  const duration = live ? activityDurationMs(activity, now) : null;
  return (
    <>
      <ActivityLine
        status={activity.status}
        source={activity.source}
        title={presentActivityTitle(activity.title)}
        meta={
          live ? (
            <span data-testid="activity-elapsed">
              {duration === null ? "" : formatDuration(duration)}
            </span>
          ) : (
            <time dateTime={activity.startedAt}>
              {formatClockTime(activity.startedAt, i18n.locale)}
            </time>
          )
        }
        liveStep={live ? (latestStepTitle(activity) ?? t`Starting`) : undefined}
        detail={activityLineText(activity, {
          in_progress: t`Working`,
          done: t`Done`,
          failed: t`Didn't finish`,
          cancelled: t`Cancelled`,
        })}
        nested={depth > 0}
        onClick={() => onOpen(activity.id)}
        testId="activity-row"
      />
      {children.length > 0 ? (
        <ActivityBranch>
          {children.map((child) => (
            <ActivityRow
              key={child.activity.id}
              node={child}
              depth={depth + 1}
              now={now}
              onOpen={onOpen}
            />
          ))}
        </ActivityBranch>
      ) : null}
    </>
  );
}

const EMPTY_ACTIVITIES: Activity[] = [];

/** A grouped list's header ("Working now 2", "Today"): 13px semibold ink, a quiet count. */
export const GROUP_LABEL =
  "px-1.5 pt-1 text-[13px] font-semibold tracking-[-0.1px] text-foreground";
const GROUP_COUNT = "ms-1 font-normal text-ink-3 tabular-nums";

/** How long the skeleton may stand in before the panel settles on its empty line instead. */
export const ACTIVITY_LOADING_GRACE_MS = 4_000;

/**
 * True once a load has run past its grace period, or straight away while the page is hidden
 * (the feed pauses then, so the read the skeleton waits on is not coming): either way the
 * panel shows its calm empty line rather than a skeleton that never ends.
 */
function useLoadingOverdue(loading: boolean): boolean {
  const [overdue, setOverdue] = useState(false);
  useEffect(() => {
    if (!loading) {
      setOverdue(false);
      return;
    }
    if (document.visibilityState === "hidden") {
      setOverdue(true);
      return;
    }
    const timer = window.setTimeout(() => setOverdue(true), ACTIVITY_LOADING_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [loading]);
  return overdue;
}

/** The same calm line, whichever of "truly nothing yet" or "this Muse has no
 * Conversation yet" (NOT_FOUND) it's for — both read the same to the person. */
function EmptyActivities() {
  const { t } = useLingui();
  return (
    <p className="px-3 py-8 text-center text-[12.5px] text-ink-3" data-testid="activity-empty">
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
  const loadingOverdue = useLoadingOverdue(state.status === "loading");

  // Both read as "nothing to show yet" — a brand new Muse with no Conversation
  // (NOT_FOUND) looks the same here as a feature not wired up in this environment
  // (NOT_IMPLEMENTED); neither is an error.
  if (state.status === "unavailable") return <EmptyActivities />;
  if (state.status === "loading") {
    return loadingOverdue ? <EmptyActivities /> : <PanelRowSkeletonList count={4} />;
  }
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
        <section className="flex flex-col gap-1.5" data-testid="activity-working">
          <h3 className={GROUP_LABEL}>
            {t`Working now`}
            <span className={GROUP_COUNT}>{working.length}</span>
          </h3>
          <div className="nova-group">
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
        <section key={group.date} className="flex flex-col gap-1.5">
          <h3 className={GROUP_LABEL}>
            {group.label.kind === "today"
              ? t`Today`
              : group.label.kind === "yesterday"
                ? t`Yesterday`
                : group.label.text}
          </h3>
          <div className="nova-group">
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
