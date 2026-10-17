import type { ThreadMessage } from "@superchat/contracts";
import { parseReplyCard } from "@superchat/contracts";
import type { StripHelper } from "./workStripState";

// The plan in the work strip (ADR 0023): the assistant's living `plan` card (`render_card` kind
// `plan`, re-rendered with the same `id`) is drawn inside the strip under its reply, not as a card
// of its own. Pure readings of the transcript, so the strip, the transcript and their tests share
// one interpretation. A reply is a turn: the assistant's messages after one of the person's.

export type PlanStatus = "todo" | "doing" | "done";

export interface PlanStep {
  text: string;
  status: PlanStatus;
  /** New in the newest render (the plan changed): the strip marks it once. */
  added: boolean;
}

/** One reply's work: what its strip draws and where it sits. */
export interface TurnWork {
  /** The message the strip sits under: the one holding the Helpers, else the reply's text. */
  anchorId: string;
  /** The newest render of the reply's plan, or null without one. */
  plan: PlanStep[] | null;
  helpers: StripHelper[];
  /** When the person asked (ms), or null when unknown. */
  startedAt: number | null;
  /** The reply's newest message (ms), or null when unknown. */
  endedAt: number | null;
  /** The newest reply in the transcript: the one a running turn is writing. */
  last: boolean;
}

export interface TranscriptWork {
  /** By anchor message id. */
  turns: Map<string, TurnWork>;
  /** `<messageId>:<blockIndex>` of every plan card a strip draws instead. */
  drawn: Set<string>;
}

export const drawnKey = (messageId: string, index: number) => `${messageId}:${index}`;

const EMPTY: TranscriptWork = { turns: new Map(), drawn: new Set() };

type PlanRender = { key: string; messageId: string; id: string | undefined; steps: PlanStep[] };

function planRenders(messages: readonly ThreadMessage[]): PlanRender[] {
  const renders: PlanRender[] = [];
  for (const message of messages) {
    message.blocks.forEach((block, index) => {
      if (block.kind !== "reply_card" || block.card !== "plan" || block.pending) return;
      const parsed = parseReplyCard(block);
      if (parsed?.kind !== "plan") return;
      renders.push({
        key: drawnKey(message.id, index),
        messageId: message.id,
        id: block.id,
        steps: parsed.data.items.map((item) => ({ ...item, added: false })),
      });
    });
  }
  return renders;
}

/** Steps of `next` whose words were not in `previous`: added or reworded. */
function markAdded(next: PlanStep[], previous: PlanStep[] | undefined): PlanStep[] {
  if (!previous) return next;
  const before = new Set(previous.map((step) => step.text));
  return next.map((step) => (before.has(step.text) ? step : { ...step, added: true }));
}

const timeOf = (iso: string | undefined) => {
  const ms = Date.parse(iso ?? "");
  return Number.isNaN(ms) ? null : ms;
};

function readTurn(
  ask: ThreadMessage | undefined,
  replies: ThreadMessage[],
  last: boolean,
  out: TranscriptWork,
) {
  const helpers = replies.flatMap((message) =>
    message.blocks.flatMap((block) => (block.kind === "helper" ? [block] : [])),
  );
  const renders = planRenders(replies);
  const newest = renders.at(-1);
  // The reply's plan is its newest render's `id`; one without an `id` stands alone.
  const mine = newest
    ? newest.id
      ? renders.filter((render) => render.id === newest.id)
      : [newest]
    : [];
  if (helpers.length === 0 && mine.length === 0) return;
  const anchor =
    replies.find((message) => message.blocks.some((block) => block.kind === "helper")) ??
    replies.findLast((message) => message.blocks.some((block) => block.kind === "text")) ??
    replies.find((message) => message.id === mine[0]?.messageId);
  if (!anchor) return;
  for (const render of mine) out.drawn.add(render.key);
  out.turns.set(anchor.id, {
    anchorId: anchor.id,
    plan: newest ? markAdded(newest.steps, mine.at(-2)?.steps) : null,
    helpers,
    startedAt: timeOf(ask?.createdAt),
    endedAt: timeOf(replies.at(-1)?.createdAt),
    last,
  });
}

/** Every reply's strip in a transcript (oldest first): a reply gets one when it started Helpers
 * or published a plan. */
export function transcriptWork(messages: readonly ThreadMessage[]): TranscriptWork {
  if (messages.length === 0) return EMPTY;
  const out: TranscriptWork = { turns: new Map(), drawn: new Set() };
  let ask: ThreadMessage | undefined;
  let replies: ThreadMessage[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      if (replies.length > 0) readTurn(ask, replies, false, out);
      ask = message;
      replies = [];
    } else {
      replies.push(message);
    }
  }
  if (replies.length > 0) readTurn(ask, replies, true, out);
  return out;
}

/** Messages that hold nothing but plan cards a strip draws, and no strip of their own: the
 * transcript drops their rows (no empty gap). */
export function drawnOnlyMessageIds(
  messages: readonly ThreadMessage[],
  work: TranscriptWork,
): Set<string> {
  const hidden = new Set<string>();
  if (work.drawn.size === 0) return hidden;
  for (const message of messages) {
    if (work.turns.has(message.id) || message.blocks.length === 0) continue;
    if (message.blocks.every((_, index) => work.drawn.has(drawnKey(message.id, index)))) {
      hidden.add(message.id);
    }
  }
  return hidden;
}
