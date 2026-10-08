// The Activity panel (CONTEXT.md "Activity", "Activity Feed", "Step"; docs/super-chat/
// WIRING.md "activities.*"): mapping from Omnigent's snake_case Activity/Step shape
// (engine/omnigent/omnigent/superchat/activity.py) to Nova's camelCase contract
// (packages/contracts/src/activity.ts). Pure: no network/database here, so ./activities.test.ts
// exercises it directly.
import type { Activity, ActivityStep } from "@nova/contracts";
import { isEngineErrorText } from "@nova/core";
import type { OmnigentActivity, OmnigentActivityStep } from "./client.js";

function epochSecondsToIso(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString();
}

export function mapActivityStep(raw: OmnigentActivityStep): ActivityStep {
  return {
    itemId: raw.item_id,
    title: raw.title,
    createdAt: epochSecondsToIso(raw.created_at),
    tool: raw.tool ?? null,
    detail: raw.detail ?? undefined,
  };
}

/** What the engine says when a run failed and it has nothing more specific. */
const GENERIC_FAILURE = "Could not complete the task";

const FAILURE_REASONS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /selected model|may not exist or you may not have access|model .*not found/i,
    "The model isn't available.",
  ],
  [/overloaded|rate.?limit|too many requests|capacity|\b(?:429|503|529)\b/i, "The model was busy."],
  [/credit|billing|quota|insufficient/i, "The model account hit its limit."],
  [/time(?:d)?[ -]?out|deadline/i, "It took too long."],
  [/connect failed|econn|network|unreachable|no runner|host/i, "Couldn't get started."],
];

/**
 * A failed run's outcome is the engine's own error text, which can be a stack of internals
 * (paths, codes, env names). Shows a short plain reason when it can tell what happened, the
 * text itself when it is already short and plain, and the generic line otherwise.
 */
export function plainFailureOutcome(raw: string | null): string | null {
  const text = raw?.replace(/^inner executor error:\s*/i, "").trim();
  if (!text) return null;
  if (text === GENERIC_FAILURE) return text;
  const known = FAILURE_REASONS.find(([pattern]) => pattern.test(text));
  if (known) return known[1];
  const plain = text.length <= 100 && !/[\\/\n]/.test(text) && !isEngineErrorText(text);
  return plain ? text : GENERIC_FAILURE;
}

export function mapActivity(raw: OmnigentActivity): Activity {
  const failed = raw.status === "failed";
  return {
    id: raw.id,
    kind: raw.kind,
    chatId: raw.chat_id,
    source: raw.source,
    title: raw.title,
    outcome: failed ? plainFailureOutcome(raw.outcome) : (raw.outcome ?? null),
    summary: failed ? plainFailureOutcome(raw.summary ?? raw.outcome) : (raw.summary ?? null),
    status: raw.status,
    startedAt: epochSecondsToIso(raw.started_at),
    finishedAt: raw.finished_at === null ? null : epochSecondsToIso(raw.finished_at),
    date: raw.date,
    parentChatId: raw.parent_chat_id ?? null,
    steps: raw.steps?.map(mapActivityStep),
  };
}
