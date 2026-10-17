import { useLingui } from "@lingui/react/macro";
import type { Activity } from "@superchat/contracts";
import { presentActivityTitle } from "@superchat/core";
import { cn } from "@superchat/ui-web";
import { Check, ChevronDown, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { SuperchatOrb } from "../../components/ai/orb";
import { Shimmer } from "../../components/ai/primitives";
import { useArtifactPanel } from "../../components/cards/context";
import { useNow } from "../../components/chrome/useNow";
import { rpc } from "../../lib/rpc";
import { ArtifactPreviewThumbnail } from "../artifacts";
import { focusActivity } from "./activityFocus";
import { activityFeedFor } from "./useActivities";
import type { PlanStep } from "./workPlan";
import {
  artifactSaveCount,
  composeStrip,
  deriveWorkStrip,
  flagsOf,
  formatClock,
  helperActivities,
  type StripHelper,
  type StripTurn,
  type StripView,
  type WorkLine,
} from "./workStripState";

/** A file a Helper of this reply saved a version of: shown under the strip. */
export interface DraftFile {
  artifactId: string;
  name: string;
  version: number;
  size?: number;
  mimeType?: string;
}

/** The strip's mark: the Superchat orb while the work runs, gone still and grey once it settles. */
function WorkMark({ live, size = 20 }: { live: boolean; size?: number }) {
  return live ? (
    <SuperchatOrb size={size} state="working" flies={false} />
  ) : (
    <span
      aria-hidden="true"
      data-testid="work-strip-still"
      className="sc-work-still shrink-0 rounded-full"
      style={{ width: size, height: size }}
    />
  );
}

/** A running Helper's line, for a reply without a plan (ADR 0022's strip). */
function WorkLineRow({ line }: { line: WorkLine }) {
  const { t } = useLingui();
  return (
    <div data-testid="work-strip-line" className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-2">
        <span className="max-w-[55%] shrink-0 truncate font-[560] text-foreground" dir="auto">
          {presentActivityTitle(line.title)}
        </span>
        <span
          data-testid="work-strip-status"
          className="min-w-0 flex-1 truncate text-ink-2"
          dir="auto"
          aria-live="polite"
        >
          · <Shimmer>{line.progress ?? t`Working`}</Shimmer>
        </span>
        {line.elapsedMs !== null ? (
          <span
            data-testid="work-strip-elapsed"
            className="shrink-0 text-[12.5px] text-ink-3 tabular-nums"
          >
            {formatClock(line.elapsedMs)}
          </span>
        ) : null}
      </div>
      {line.flags.map((flag, index) => (
        // Flags only accumulate, oldest first: the position is the flag.
        <Flag key={index} text={flag} />
      ))}
    </div>
  );
}

/** Something a Helper flagged: a warning-tinted line, shown at once. */
function Flag({ text }: { text: string }) {
  return (
    <div
      data-testid="work-strip-flag"
      className="sc-work-flag flex min-w-0 items-start gap-2 rounded-lg bg-warn/12 px-[9px] py-1.5 text-[12.5px] leading-[1.4] text-foreground"
    >
      <TriangleAlert
        aria-hidden="true"
        size={13}
        strokeWidth={2.2}
        className="mt-px shrink-0 text-warning"
      />
      <span className="min-w-0" dir="auto">
        {text}
      </span>
    </div>
  );
}

/** One step of the plan: done (a filled check that pops in), doing (the orb, bold, with the latest
 * progress sentence shimmering under it), or to do (a hollow circle, muted). */
function PlanRow({ step, progress }: { step: PlanStep; progress: string | null }) {
  const { t } = useLingui();
  return (
    <li
      data-testid="work-plan-step"
      data-status={step.status}
      data-added={step.added || undefined}
      className={cn(
        "grid grid-cols-[20px_minmax(0,1fr)] items-start gap-x-[9px] rounded-[7px] py-1 text-[13.5px] leading-[1.4] transition-colors duration-300",
        step.status === "todo" && "text-ink-3",
        step.status === "doing" && "font-[560] text-foreground",
        step.status === "done" && "text-foreground",
        step.added && "sc-work-added",
      )}
    >
      <span aria-hidden="true" className="grid size-5 place-items-center">
        {step.status === "done" ? (
          <span className="sc-work-pop grid size-[15px] place-items-center rounded-full bg-foreground text-content">
            <Check size={10} strokeWidth={3} />
          </span>
        ) : step.status === "doing" ? (
          <SuperchatOrb size={13} state="working" flies={false} />
        ) : (
          <span className="size-[11px] rounded-full border-[1.5px] border-ink-3 opacity-70" />
        )}
      </span>
      <span className="min-w-0" dir="auto">
        <span key={step.text} className="sc-work-in">
          {step.text}
        </span>
        {step.added ? (
          <span className="sc-work-tag ms-2 inline-block text-[11px] font-medium text-tint">
            {t`Plan updated`}
          </span>
        ) : null}
      </span>
      {step.status === "doing" && progress ? (
        <span
          key={progress}
          data-testid="work-plan-progress"
          className="sc-work-in col-start-2 mt-px text-[12.5px] font-normal text-ink-2"
          dir="auto"
          aria-live="polite"
        >
          <Shimmer>{progress}</Shimmer>
        </span>
      ) : null}
    </li>
  );
}

/** Files the work is writing, as a row of thumbnails filling in; each opens beside the chat. */
function DraftThumbs({ drafts, updating }: { drafts: readonly DraftFile[]; updating: boolean }) {
  const panel = useArtifactPanel();
  return (
    <div data-testid="work-strip-drafts" className="grid grid-cols-6 gap-1.5 pt-0.5">
      {drafts.map((draft) => (
        <button
          key={draft.artifactId}
          type="button"
          data-testid="work-strip-draft"
          data-updating={updating || undefined}
          title={draft.name}
          aria-label={draft.name}
          onClick={() => panel?.open(draft.artifactId, draft.name)}
          className="sc-work-thumb relative aspect-video overflow-hidden rounded-[4px] border border-separator bg-bubble focus-visible:outline-2 focus-visible:outline-ring"
        >
          <ArtifactPreviewThumbnail
            artifact={{
              id: draft.artifactId,
              name: draft.name,
              version: draft.version,
              size: draft.size ?? 0,
              mimeType: draft.mimeType ?? "",
            }}
          />
        </button>
      ))}
    </div>
  );
}

const LINK =
  "shrink-0 rounded-sm text-[12.5px] text-ink-2 underline-offset-2 transition-colors hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring";

/**
 * The work strip under a reply (ADR 0022, ADR 0023). While the work runs it is lit: a slowly
 * turning edge in the tint family, the orb as its mark, the current step, a clock, a progress bar,
 * anything a Helper flagged, and the reply's plan (done, doing with its latest progress sentence,
 * to do). Without a plan it shows one line per running Helper, as before. Settled, it goes still:
 * "4 of 4 done" (or "Done") and the span, with the plan behind a "Plan" toggle. "Show details"
 * opens the Activity panel on the work.
 */
export function WorkStripView({
  view,
  drafts = [],
  onShowDetails,
}: {
  view: StripView;
  drafts?: readonly DraftFile[];
  onShowDetails: () => void;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const { live, plan } = view;
  const done = plan?.filter((step) => step.status === "done").length ?? 0;
  const total = plan?.length ?? 0;
  const shown = live || open;
  const current =
    plan?.find((step) => step.status === "doing") ?? plan?.find((step) => step.status === "todo");
  const now = current?.text ?? view.lines[0]?.title ?? view.progress ?? t`Working`;
  const settled = plan
    ? t`${done} of ${total} done`
    : view.outcome === "failed"
      ? t`Didn't finish`
      : view.outcome === "cancelled"
        ? t`Cancelled`
        : t`Done`;
  const clock =
    view.clockMs !== null ? (
      <span
        data-testid="work-strip-clock"
        className="ms-auto shrink-0 text-[12.5px] text-ink-3 tabular-nums"
      >
        {formatClock(view.clockMs)}
      </span>
    ) : (
      <span className="ms-auto" />
    );
  const details = (
    <button type="button" data-testid="work-strip-details" onClick={onShowDetails} className={LINK}>
      {t`Show details`}
    </button>
  );
  return (
    <div
      data-testid="work-strip"
      data-state={live ? "working" : "settled"}
      data-live={live || undefined}
      className="sc-work mt-2.5 w-[520px] max-w-full"
    >
      <div className="flex flex-col gap-[9px] rounded-[12.5px] bg-content px-3.5 pt-[11px] pb-2.5">
        {live && !plan && view.lines.length > 0 ? (
          <div className="flex min-w-0 items-start gap-2.5 text-[13.5px]">
            <WorkMark live />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5 pt-px">
              {view.lines.map((line) => (
                <WorkLineRow key={line.helperId} line={line} />
              ))}
            </div>
            {details}
          </div>
        ) : (
          <div className="flex min-w-0 items-center gap-2.5 text-[13.5px]">
            <WorkMark live={live} />
            {live ? (
              <span
                key={now}
                data-testid="work-strip-now"
                className="sc-work-in min-w-0 truncate font-[560]"
                dir="auto"
              >
                {now}
              </span>
            ) : (
              <span
                data-testid="work-strip-settled"
                className="min-w-0 truncate font-[560] whitespace-nowrap"
              >
                {settled}
              </span>
            )}
            {clock}
            {!live && plan ? (
              <button
                type="button"
                data-testid="work-strip-plan-toggle"
                aria-expanded={open}
                onClick={() => setOpen((value) => !value)}
                className={cn(LINK, "inline-flex items-center gap-0.5")}
              >
                {t`Plan`}
                <ChevronDown
                  aria-hidden="true"
                  size={13}
                  strokeWidth={2}
                  className={cn("transition-transform duration-200", open && "rotate-180")}
                />
              </button>
            ) : null}
            {details}
          </div>
        )}
        {live && plan ? (
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={done}
            data-testid="work-strip-progress"
            className="h-[3px] overflow-hidden rounded-[2px] bg-separator"
          >
            <span
              className="block h-full rounded-[2px] bg-linear-to-r from-tint to-tint-2 transition-[width] duration-600 ease-out"
              style={{ width: `${total ? (done / total) * 100 : 0}%` }}
            />
          </div>
        ) : null}
        {plan && shown ? view.flags.map((flag, index) => <Flag key={index} text={flag} />) : null}
        {plan && shown ? (
          <ul data-testid="work-plan" className="m-0 flex list-none flex-col p-0">
            {plan.map((step, index) => (
              <PlanRow
                // Steps are their words; a repeated step keeps its place.
                key={`${step.text}#${plan.slice(0, index).filter((s) => s.text === step.text).length}`}
                step={step}
                progress={view.progress}
              />
            ))}
          </ul>
        ) : null}
        {drafts.length > 0 && (shown || !plan) ? (
          <DraftThumbs drafts={drafts} updating={live} />
        ) : null}
      </div>
    </div>
  );
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
        mimeType: artifact.mimeType,
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

/** The work strip for one reply: its Helpers live from the shared Activity feed, and the reply's
 * own plan and running state (`turn`, from the transcript). */
export function WorkStrip({
  botId,
  helpers,
  turn,
}: {
  botId: string;
  helpers: readonly StripHelper[];
  turn?: StripTurn;
}) {
  const feed = activityFeedFor(botId);
  const { state: feedState } = useSyncExternalStore(feed.subscribe, feed.getSnapshot);
  const activities = feedState.status === "ready" ? feedState.activities : undefined;
  const helpersLive = useMemo(
    () => deriveWorkStrip(helpers, activities, 0).kind === "working",
    [helpers, activities],
  );
  const live = helpersLive || Boolean(turn?.live);
  const now = useNow(live);
  const listed = useMemo(() => helperActivities(helpers, activities), [helpers, activities]);
  const view = useMemo(
    () =>
      composeStrip(deriveWorkStrip(helpers, activities, now), listed.flatMap(flagsOf), turn, now),
    [helpers, activities, listed, turn, now],
  );
  const drafts = useHelperDrafts(botId, listed);
  // A Helper that started a moment ago may not be listed yet: ask the feed once more.
  const missing = helpersLive && feedState.status === "ready" && listed.length < helpers.length;
  useEffect(() => {
    if (missing) feed.refresh();
  }, [feed, missing]);
  return (
    <WorkStripView view={view} drafts={drafts} onShowDetails={() => focusActivity(view.focusId)} />
  );
}
