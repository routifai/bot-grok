// Redaction for Omnigent read paths (docs/super-chat/WIRING.md review item 4): `chats.messages`
// text, `activities.list`/`activities.get` (title, outcome, summary, step titles, and step `detail`
// recursively for string values), and `memory.profile`. Built on the same `redactSecrets`
// primitive ./gateway.ts and ./mirror.ts redact a turn's reply with, over the same secrets list
// (./env.ts's `omnigentRedactionSecretsFromEnv`) — so nothing Omnigent returns can surface a
// deployment secret anywhere it reaches a person, whichever path read it.
import type { Activity, ActivityStep, ThreadMessage } from "@aiden/contracts";
import { redactSecrets } from "@aiden/core";

function redactString(value: string, secrets: string[]): string {
  return secrets.length === 0 ? value : redactSecrets(value, secrets);
}

/** `chats.messages`: redacts every `text` block's text and every Helper row's title. The
 * other blocks (cards carry their own redaction, see ./cards.ts) pass through unchanged. */
export function redactThreadMessages(
  messages: ThreadMessage[],
  secrets: string[],
): ThreadMessage[] {
  if (secrets.length === 0) return messages;
  return messages.map((message) => ({
    ...message,
    blocks: message.blocks.map((block) =>
      block.kind === "text"
        ? { ...block, text: redactString(block.text, secrets) }
        : block.kind === "helper"
          ? { ...block, title: redactString(block.title, secrets) }
          : block,
    ),
  }));
}

/** Recursively redacts every string value in a Step's `detail` (an arbitrary tool-call
 * arguments/output snapshot, capped by the engine — engine/omnigent/omnigent/superchat/
 * activity.py) — keys, numbers, and booleans are left alone. */
function redactDetailDeep(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") return redactString(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactDetailDeep(item, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        redactDetailDeep(nested, secrets),
      ]),
    );
  }
  return value;
}

function redactActivityStep(step: ActivityStep, secrets: string[]): ActivityStep {
  return {
    ...step,
    title: redactString(step.title, secrets),
    detail:
      step.detail === undefined || step.detail === null
        ? step.detail
        : (redactDetailDeep(step.detail, secrets) as ActivityStep["detail"]),
  };
}

/** `activities.list`/`activities.get`: redacts `title`, `outcome`, `summary`, and every Step's `title` and
 * `detail`. */
export function redactActivity(activity: Activity, secrets: string[]): Activity {
  if (secrets.length === 0) return activity;
  return {
    ...activity,
    title: redactString(activity.title, secrets),
    outcome: activity.outcome === null ? null : redactString(activity.outcome, secrets),
    summary: activity.summary === null ? null : redactString(activity.summary, secrets),
    steps: activity.steps?.map((step) => redactActivityStep(step, secrets)),
  };
}

/** `memory.profile`: redacts the Memory Profile text itself. */
export function redactMemoryProfile(profile: string | null, secrets: string[]): string | null {
  if (profile === null || secrets.length === 0) return profile;
  return redactString(profile, secrets);
}
