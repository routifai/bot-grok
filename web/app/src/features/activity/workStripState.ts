import type { Activity, MessageBlock, ThreadMessage } from "@superchat/contracts";
import { isRunning } from "./activityGrouping";
import { buildActivityForest, findHelperNode, isNodeRunning } from "./activityTree";

// The work strip under a reply (docs/conversation.md "The assistant narrates while helpers
// work"): pure readings of the Activity feed for the Helpers a message started, so the strip,
// its tests and the dev preview share one interpretation. A Helper's `report_progress` and
// `raise_flag` calls are Steps of its Activity (engine `step_title_for_call`): the progress text
// as the title, a flag as "Flagged: <text>".

/** A Helper as the transcript names it: its chat id, a fallback title, its status then. */
export type StripHelper = Pick<
  Extract<MessageBlock, { kind: "helper" }>,
  "helperId" | "title" | "status"
>;

/** One running Helper's line. */
export interface WorkLine {
  helperId: string;
  title: string;
  /** Its latest progress sentence; null until it has reported one. */
  progress: string | null;
  /** What it flagged, oldest first. */
  flags: string[];
  /** How long it has been going; null before the feed lists it. */
  elapsedMs: number | null;
}

export type WorkStripState =
  | { kind: "working"; lines: WorkLine[]; focusId: string | null }
  | {
      kind: "settled";
      outcome: "done" | "failed" | "cancelled";
      /** First start to last finish; null when the feed has none of them. */
      ms: number | null;
      focusId: string | null;
    };

const PROGRESS_TOOL = "report_progress";
const FLAG_TOOL = "raise_flag";
const FLAG_PREFIX = "Flagged: ";
const ARTIFACT_SAVE_TOOL = "artifact_save";

/** A Helper's latest progress sentence, if it has reported one. */
export function latestProgress(activity: Pick<Activity, "steps">): string | null {
  const steps = activity.steps ?? [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step?.tool === PROGRESS_TOOL && step.title) return step.title;
  }
  return null;
}

/** What a Helper flagged, in its own words, oldest first. */
export function flagsOf(activity: Pick<Activity, "steps">): string[] {
  return (activity.steps ?? [])
    .filter((step) => step.tool === FLAG_TOOL && step.title)
    .map((step) =>
      step.title.startsWith(FLAG_PREFIX) ? step.title.slice(FLAG_PREFIX.length) : step.title,
    );
}

/** How many times these Activities saved a file: a new save is the cue to look for a draft. */
export function artifactSaveCount(activities: readonly Activity[]): number {
  return activities.reduce(
    (count, activity) =>
      count + (activity.steps ?? []).filter((step) => step.tool === ARTIFACT_SAVE_TOOL).length,
    0,
  );
}

/** A span on a clock: "0:41", "2:14", "1:02:09". Whole seconds, never negative. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** The Activities of these Helpers that the feed lists (their own rows, not their parts). */
export function helperActivities(
  helpers: readonly StripHelper[],
  activities: readonly Activity[] | undefined,
): Activity[] {
  if (!activities) return [];
  const forest = buildActivityForest(activities);
  return helpers
    .map((helper) => findHelperNode(forest, helper.helperId)?.activity)
    .filter((activity): activity is Activity => activity !== undefined);
}

/**
 * The strip for the Helpers one message started. Working while any of them (or a part it handed
 * on) runs: one line per running Helper. Otherwise settled, with the whole span. A Helper the feed
 * does not list (not loaded yet, or older than its newest page) falls back to the status the
 * transcript carried.
 */
export function deriveWorkStrip(
  helpers: readonly StripHelper[],
  activities: readonly Activity[] | undefined,
  now: number,
): WorkStripState {
  const forest = activities ? buildActivityForest(activities) : [];
  const read = helpers.map((helper) => {
    const node = findHelperNode(forest, helper.helperId);
    return {
      helper,
      activity: node?.activity,
      running: node ? isNodeRunning(node) : helper.status === "in_progress",
    };
  });
  const running = read.filter((entry) => entry.running);
  const focusId = (running[0] ?? read.find((entry) => entry.activity))?.activity?.id ?? null;
  if (running.length > 0) {
    return {
      kind: "working",
      focusId,
      lines: running.map(({ helper, activity }) => ({
        helperId: helper.helperId,
        title: activity?.title || helper.title,
        progress: activity ? latestProgress(activity) : null,
        flags: activity ? flagsOf(activity) : [],
        elapsedMs: activity ? Math.max(0, now - Date.parse(activity.startedAt)) : null,
      })),
    };
  }
  const statuses = read.map((entry) => entry.activity?.status ?? entry.helper.status);
  const outcome = statuses.includes("failed")
    ? "failed"
    : statuses.length > 0 && statuses.every((status) => status === "cancelled")
      ? "cancelled"
      : "done";
  const listed = read.flatMap((entry) => (entry.activity ? [entry.activity] : []));
  const starts = listed.map((activity) => Date.parse(activity.startedAt));
  const ends = listed.map((activity) => Date.parse(activity.finishedAt ?? ""));
  const ms =
    listed.length > 0 && [...starts, ...ends].every((value) => !Number.isNaN(value))
      ? Math.max(0, Math.max(...ends) - Math.min(...starts))
      : null;
  return { kind: "settled", outcome, ms, focusId };
}

function helperBlocks(message: ThreadMessage): StripHelper[] {
  return message.blocks.flatMap((block) => (block.kind === "helper" ? [block] : []));
}

/**
 * The replies the assistant gave while earlier work was still going (ADR 0022 "Questions are
 * answered on the main turn"): the first text reply to a person's message sent after a message
 * started Helpers, arriving while one of those Helpers ran. A reply that starts Helpers of its own
 * is new work, not an answer on the side.
 */
export function answeredWhileWorking(
  messages: readonly ThreadMessage[],
  activities: readonly Activity[] | undefined,
): Set<string> {
  const answered = new Set<string>();
  const forest = activities ? buildActivityForest(activities) : [];
  const windows: Array<{ index: number; start: number; end: number }> = [];
  messages.forEach((message, index) => {
    if (message.role !== "bot") return;
    for (const helper of helperBlocks(message)) {
      const activity = findHelperNode(forest, helper.helperId)?.activity;
      if (activity) {
        const start = Date.parse(activity.startedAt);
        const end = isRunning(activity) ? Infinity : Date.parse(activity.finishedAt ?? "");
        if (!Number.isNaN(start) && !Number.isNaN(end)) windows.push({ index, start, end });
      } else if (helper.status === "in_progress") {
        windows.push({ index, start: Date.parse(message.createdAt), end: Infinity });
      }
    }
  });
  if (windows.length === 0) return answered;
  let personIndex = -1;
  let replied = false;
  messages.forEach((message, index) => {
    if (message.role === "user") {
      personIndex = index;
      replied = false;
      return;
    }
    if (replied || personIndex < 0 || message.id.startsWith("progress:")) return;
    if (!message.blocks.some((block) => block.kind === "text")) return;
    replied = true;
    if (helperBlocks(message).length > 0) return;
    const asked = Date.parse(messages[personIndex]?.createdAt ?? "");
    const at = Date.parse(message.createdAt);
    if (
      windows.some(
        (window) => window.index < personIndex && asked >= window.start && at < window.end,
      )
    ) {
      answered.add(message.id);
    }
  });
  return answered;
}
