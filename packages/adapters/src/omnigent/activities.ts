// The Activity panel (CONTEXT.md "Activity", "Activity Feed", "Step"; docs/super-chat/
// WIRING.md "activities.*"): mapping from Omnigent's snake_case Activity/Step shape
// (engine/omnigent/omnigent/superchat/activity.py) to Nova's camelCase contract
// (packages/contracts/src/activity.ts). Pure: no network/database here, so ./activities.test.ts
// exercises it directly.
import type { Activity, ActivityStep } from "@aiden/contracts";
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

export function mapActivity(raw: OmnigentActivity): Activity {
  return {
    id: raw.id,
    kind: raw.kind,
    chatId: raw.chat_id,
    source: raw.source,
    title: raw.title,
    outcome: raw.outcome ?? null,
    summary: raw.summary ?? null,
    status: raw.status,
    startedAt: epochSecondsToIso(raw.started_at),
    finishedAt: raw.finished_at === null ? null : epochSecondsToIso(raw.finished_at),
    date: raw.date,
    steps: raw.steps?.map(mapActivityStep),
  };
}
