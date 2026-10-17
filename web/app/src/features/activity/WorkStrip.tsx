import { useLingui } from "@lingui/react/macro";
import type { Activity } from "@superchat/contracts";
import { presentActivityTitle } from "@superchat/core";
import { TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Shimmer } from "../../components/ai/primitives";
import { useNow } from "../../components/chrome/useNow";
import { rpc } from "../../lib/rpc";
import { ReplyArtifactFileCard } from "../artifacts";
import { WorkingDot } from "./ActivityLine";
import { focusActivity } from "./activityFocus";
import { activityFeedFor } from "./useActivities";
import {
  artifactSaveCount,
  deriveWorkStrip,
  formatClock,
  helperActivities,
  type StripHelper,
  type WorkLine,
  type WorkStripState,
} from "./workStripState";

/** A file a Helper of this reply saved a version of: shown under the strip. */
export interface DraftFile {
  artifactId: string;
  name: string;
  version: number;
  size?: number;
}

function WorkLineRow({ line }: { line: WorkLine }) {
  const { t } = useLingui();
  return (
    <div data-testid="work-strip-line" className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-2">
        <span aria-hidden="true" className="grid size-3.5 shrink-0 place-items-center">
          <WorkingDot />
        </span>
        <span className="max-w-[55%] shrink-0 truncate text-foreground" dir="auto">
          {presentActivityTitle(line.title)}
        </span>
        <span
          data-testid="work-strip-status"
          className="min-w-0 flex-1 truncate text-ink-3"
          dir="auto"
          aria-live="polite"
        >
          · <Shimmer>{line.progress ?? t`Working`}</Shimmer>
        </span>
        {line.elapsedMs !== null ? (
          <span
            data-testid="work-strip-elapsed"
            className="shrink-0 font-mono text-[12px] text-ink-3 tabular-nums"
          >
            {formatClock(line.elapsedMs)}
          </span>
        ) : null}
      </div>
      {line.flags.map((flag, index) => (
        <div
          // Flags only accumulate, oldest first: the position is the flag.
          key={index}
          data-testid="work-strip-flag"
          className="flex min-w-0 items-start gap-2 text-[12.5px] leading-[1.4] text-foreground"
        >
          <span aria-hidden="true" className="grid h-[17px] w-3.5 shrink-0 place-items-center">
            <TriangleAlert size={13} strokeWidth={2} className="text-warning" />
          </span>
          <span className="min-w-0" dir="auto">
            {flag}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * The work strip under a reply (ADR 0022): while its Helpers run, one line each (title, the
 * latest progress sentence or "Working", time on a clock) with anything they flagged right under
 * it; once they are all done, one line that stays ("Done · 2:14"). "Show details" opens the
 * Activity panel on the Helper. A file a Helper is writing shows as the chat's file card, marked
 * "Updating" until the work is done.
 */
export function WorkStripView({
  state,
  drafts = [],
  onShowDetails,
}: {
  state: WorkStripState;
  drafts?: readonly DraftFile[];
  onShowDetails: () => void;
}) {
  const { t } = useLingui();
  const working = state.kind === "working";
  const settled =
    state.kind === "settled"
      ? state.outcome === "failed"
        ? t`Didn't finish`
        : state.outcome === "cancelled"
          ? t`Cancelled`
          : t`Done`
      : "";
  return (
    <div
      data-testid="work-strip"
      data-state={state.kind}
      className="mt-2.5 flex w-[520px] max-w-full flex-col gap-2"
    >
      <div className="flex min-w-0 items-start gap-3 rounded-xl bg-window px-3 py-2 text-[13px] leading-[1.35]">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          {state.kind === "working" ? (
            state.lines.map((line) => <WorkLineRow key={line.helperId} line={line} />)
          ) : (
            <span data-testid="work-strip-settled" className="text-ink-2 tabular-nums">
              {state.ms !== null ? `${settled} · ${formatClock(state.ms)}` : settled}
            </span>
          )}
        </div>
        <button
          type="button"
          data-testid="work-strip-details"
          onClick={onShowDetails}
          className="shrink-0 rounded-sm text-[12px] text-ink-2 underline-offset-2 transition-colors hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
        >
          {t`Show details`}
        </button>
      </div>
      {drafts.map((draft) => (
        <div key={draft.artifactId} data-testid="work-strip-draft">
          <ReplyArtifactFileCard
            updating={working}
            data={{
              name: draft.name,
              artifactId: draft.artifactId,
              version: draft.version,
              versions: draft.version,
              ...(draft.size !== undefined ? { size: draft.size } : {}),
              ...(extensionOf(draft.name) ? { kind: extensionOf(draft.name) } : {}),
            }}
          />
        </div>
      ))}
    </div>
  );
}

function extensionOf(name: string): string | undefined {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : undefined;
}

/** At most this many recent files are checked for a Helper's draft on each save. */
const DRAFT_CANDIDATES = 6;

/** The files these Helpers saved: the newest version of a recent file is a save (`ai`) or a live
 * update (`update`) by one of them. */
async function findDrafts(
  botId: string,
  helperIds: readonly string[],
  since: number,
): Promise<DraftFile[]> {
  const artifacts = await rpc.artifacts.list({ botId });
  const recent = artifacts
    .filter((artifact) => Date.parse(artifact.createdAt) >= since)
    .slice(0, DRAFT_CANDIDATES);
  const found: DraftFile[] = [];
  for (const artifact of recent) {
    const [newest] = await rpc.artifacts.listVersions({ familyId: artifact.id });
    if (
      newest?.chatId &&
      helperIds.includes(newest.chatId) &&
      (newest.origin === "ai" || newest.origin === "update")
    ) {
      found.push({
        artifactId: artifact.id,
        name: artifact.name,
        version: artifact.version,
        size: artifact.size,
      });
    }
  }
  return found;
}

/** Looks again each time one of the Helpers saves a file (a new `artifact_save` Step). */
function useHelperDrafts(botId: string, listed: readonly Activity[]): DraftFile[] {
  const [drafts, setDrafts] = useState<DraftFile[]>([]);
  const saves = artifactSaveCount(listed);
  const helperKey = listed.map((activity) => activity.chatId).join(" ");
  const since = Math.min(...listed.map((activity) => Date.parse(activity.startedAt)));
  useEffect(() => {
    if (saves === 0 || !helperKey) return;
    let cancelled = false;
    findDrafts(botId, helperKey.split(" "), since).then(
      (found) => {
        if (!cancelled) setDrafts(found);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [botId, helperKey, saves, since]);
  return drafts;
}

/** The work strip for the Helpers one reply started, live from the shared Activity feed. */
export function WorkStrip({ botId, helpers }: { botId: string; helpers: readonly StripHelper[] }) {
  const feed = activityFeedFor(botId);
  const { state: feedState } = useSyncExternalStore(feed.subscribe, feed.getSnapshot);
  const activities = feedState.status === "ready" ? feedState.activities : undefined;
  const live = useMemo(
    () => deriveWorkStrip(helpers, activities, 0).kind === "working",
    [helpers, activities],
  );
  const now = useNow(live);
  const state = useMemo(
    () => deriveWorkStrip(helpers, activities, now),
    [helpers, activities, now],
  );
  const listed = useMemo(() => helperActivities(helpers, activities), [helpers, activities]);
  const drafts = useHelperDrafts(botId, listed);
  // A Helper that started a moment ago may not be listed yet: ask the feed once more.
  const missing = live && feedState.status === "ready" && listed.length < helpers.length;
  useEffect(() => {
    if (missing) feed.refresh();
  }, [feed, missing]);
  return (
    <WorkStripView
      state={state}
      drafts={drafts}
      onShowDetails={() => focusActivity(state.focusId)}
    />
  );
}
