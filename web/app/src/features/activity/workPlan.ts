import type { PlanState, ThreadMessage } from "@superchat/contracts";
import { parseReplyCard, planItemState } from "@superchat/contracts";
import type { StripHelper } from "./workStripState";

// The plan in the work strip (ADR 0023): the assistant's living `plan` card (`render_card` kind
// `plan`, re-rendered with the same `id`) is drawn inside the strip under its reply, not as a card
// of its own. Pure readings of the transcript, so the strip, the transcript and their tests share
// one interpretation.
//
// A reply is a turn: the assistant's messages after one of the person's. The engine keeps one text
// per turn (its last, after the turn's cards), and it drops the runtime's notices: the narration a
// Helper's wake turn writes arrives as a second text after the person's last message. So a text
// closes the reply's own messages; what follows it belongs to the reply only when it carries the
// reply's plan (by `id`, even past a message the person steered into the running turn).

/** What a step reads (ADR 0027): the engine's `state`, else the model's `status` on a plan from
 * before the engine read it. */
export type PlanStatus = PlanState;

export interface PlanStep {
  text: string;
  status: PlanStatus;
  /** The step in the present tense, shown while it is doing. */
  active?: string;
  /** The engine read this step from its evidence: its state stands once the work settles. */
  engine?: true;
  /** New in the newest render (inserted, or past the previous end): the strip marks it once. */
  added: boolean;
  /** Reworded in the newest render (same place, new words): the strip cross-fades it once. */
  changed?: boolean;
}

/** How a reply ended: normally, failing, cut short, or waiting on the person's answer. */
export type TurnOutcome = "done" | "failed" | "cancelled" | "asked";

/** One reply's work: what its strip draws and where it sits. */
export interface TurnWork {
  /** The message the strip sits under: the reply's text, else its first plan card or Helper. */
  anchorId: string;
  /** The newest render of the reply's plan, or null without one. */
  plan: PlanStep[] | null;
  /** The plan card a comment on a step names: its `id`, else its block (`<messageId>:<index>`). */
  planId: string | null;
  /** How many leading done steps of the plan fold away, as the engine counts them (ADR 0027). */
  fold: number;
  /** The Activity of the reply's own turn (the engine's `activity_id` on its messages). */
  activityId: string | null;
  /** The files the reply's own turn saved (its file cards), by artifact id. */
  files: string[];
  helpers: StripHelper[];
  /** When the person asked (ms), or null when unknown. */
  startedAt: number | null;
  /** The reply's newest message (ms), or null when unknown. */
  endedAt: number | null;
  /** The reply owns the transcript's newest messages: the one a running turn is writing. */
  last: boolean;
  /** How the reply ended, read from its messages; only meaningful once it no longer runs. */
  outcome?: TurnOutcome;
}

export interface TranscriptWork {
  /** By anchor message id. */
  turns: Map<string, TurnWork>;
  /** `<messageId>:<blockIndex>` of every plan card and Helper block a strip draws instead. */
  drawn: Set<string>;
  /** When the work the newest messages belong to began (ms): the header pill's start while a turn
   * runs, the same start its strip counts from. Null when unknown. */
  runningSince?: number | null;
}

export const drawnKey = (messageId: string, index: number) => `${messageId}:${index}`;

const EMPTY: TranscriptWork = { turns: new Map(), drawn: new Set(), runningSince: null };

type PlanRender = {
  key: string;
  messageId: string;
  id: string | undefined;
  steps: PlanStep[];
  fold: number;
};

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
        fold: block.fold ?? 0,
        id: block.id,
        steps: parsed.data.items.map((item) => ({
          text: item.text,
          status: planItemState(item),
          ...(item.active ? { active: item.active } : {}),
          ...(item.state ? { engine: true as const } : {}),
          added: false,
        })),
      });
    });
  }
  return renders;
}

/** Steps of `next` set against `previous` by place and words: a step whose place held other words
 * that are gone is reworded (`changed`); a step inserted, repeated or past the end is `added`. */
export function markChanges(next: PlanStep[], previous: PlanStep[] | undefined): PlanStep[] {
  if (!previous) return next;
  let j = 0;
  return next.map((step, i) => {
    if (previous[j]?.text === step.text) {
      j++;
      return step;
    }
    // Steps dropped since: skip to where this one was.
    const ahead = previous.findIndex((old, k) => k > j && old.text === step.text);
    if (ahead >= 0) {
      j = ahead + 1;
      return step;
    }
    const replaced = previous[j];
    if (replaced && !next.slice(i + 1).some((later) => later.text === replaced.text)) {
      j++;
      return { ...step, changed: true };
    }
    return { ...step, added: true };
  });
}

const timeOf = (iso: string | undefined) => {
  const ms = Date.parse(iso ?? "");
  return Number.isNaN(ms) ? null : ms;
};

const hasText = (message: ThreadMessage) => message.blocks.some((block) => block.kind === "text");
const hasHelper = (message: ThreadMessage) =>
  message.blocks.some((block) => block.kind === "helper");

/** A run of messages: the person's message (if any) and the assistant's up to its first text. */
type Segment = { ask: ThreadMessage | undefined; replies: ThreadMessage[] };

function segmentsOf(messages: readonly ThreadMessage[]): Segment[] {
  const segments: Segment[] = [];
  for (const message of messages) {
    const current = segments.at(-1);
    if (message.role === "user") segments.push({ ask: message, replies: [] });
    else if (!current || current.replies.some(hasText)) {
      segments.push({ ask: undefined, replies: [message] });
    } else current.replies.push(message);
  }
  return segments;
}

type Turn = { ask: ThreadMessage | undefined; replies: ThreadMessage[] };

/** How a reply ended, from its messages. */
export function outcomeOf(replies: readonly ThreadMessage[]): TurnOutcome {
  const blocks = replies.flatMap((message) => message.blocks);
  if (blocks.some((block) => block.kind === "error" && block.level !== "info")) return "failed";
  if (
    blocks.some(
      (block) =>
        (block.kind === "ask" && block.status !== "answered") ||
        (block.kind === "reply_card" && (block.card === "ask" || block.card === "secure_entry")),
    )
  ) {
    return "asked";
  }
  // A reply that said or made anything (words, a file, a Helper, a plan) finished; one that left
  // nothing but live status was stopped before it could. The work state says when a Stop cut it.
  return blocks.some((block) => block.kind !== "progress" && block.kind !== "steps")
    ? "done"
    : "cancelled";
}

function readTurn(turn: Turn, last: boolean, out: TranscriptWork) {
  const { replies } = turn;
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
  // Under the reply (ADR 0022, ADR 0023): its text once written, before that where its work
  // first showed.
  const anchor =
    replies.find(hasText) ??
    replies.find(
      (message) => hasHelper(message) || renders.some((render) => render.messageId === message.id),
    );
  if (!anchor) return;
  for (const render of mine) out.drawn.add(render.key);
  for (const message of replies) {
    message.blocks.forEach((block, index) => {
      if (block.kind === "helper") out.drawn.add(drawnKey(message.id, index));
    });
  }
  out.turns.set(anchor.id, {
    anchorId: anchor.id,
    plan: newest ? markChanges(newest.steps, mine.at(-2)?.steps) : null,
    planId: newest ? (newest.id ?? newest.key) : null,
    fold: newest?.fold ?? 0,
    activityId:
      anchor.activityId ?? replies.findLast((message) => message.activityId)?.activityId ?? null,
    files: replies.flatMap((message) =>
      message.blocks.flatMap((block) =>
        block.kind === "reply_card" &&
        block.card === "file" &&
        typeof block.data.artifactId === "string"
          ? [block.data.artifactId]
          : [],
      ),
    ),
    helpers,
    startedAt: timeOf(turn.ask?.createdAt),
    endedAt: timeOf(replies.at(-1)?.createdAt),
    last,
    outcome: outcomeOf(replies),
  });
}

/** Every reply's strip in a transcript (oldest first): a reply gets one when it started Helpers
 * or published a plan. */
export function transcriptWork(messages: readonly ThreadMessage[]): TranscriptWork {
  if (messages.length === 0) return EMPTY;
  const out: TranscriptWork = { turns: new Map(), drawn: new Set(), runningSince: null };
  const turns: Turn[] = [];
  const byPlanId = new Map<string, Turn>();
  /** The turn the newest messages so far belong to, if any. */
  let newest: Turn | undefined;
  const segments = segmentsOf(messages);
  for (const segment of segments) {
    const ids = planRenders(segment.replies).flatMap((render) => (render.id ? [render.id] : []));
    const continued = ids.map((id) => byPlanId.get(id)).findLast((turn) => turn !== undefined);
    let owner: Turn | undefined;
    if (continued) {
      // The reply's plan goes on (the person's message was steered into its turn).
      owner = continued;
      owner.replies.push(...segment.replies);
    } else if (segment.ask) {
      owner = { ask: segment.ask, replies: [...segment.replies] };
      turns.push(owner);
    } else if (ids.length > 0 || segment.replies.some(hasHelper)) {
      owner = { ask: undefined, replies: [...segment.replies] };
      turns.push(owner);
    } else if (!segment.replies.some(hasText)) {
      // Cards after the reply's text, or a running turn's next steps: still the same reply.
      owner = newest;
      owner?.replies.push(...segment.replies);
    }
    // Otherwise a wake turn's narration: no reply's own work.
    for (const id of ids) if (owner) byPlanId.set(id, owner);
    newest = owner;
  }
  for (const turn of turns) readTurn(turn, turn === newest, out);
  const tail = segments.at(-1);
  out.runningSince = timeOf(
    newest?.ask?.createdAt ??
      newest?.replies[0]?.createdAt ??
      tail?.ask?.createdAt ??
      tail?.replies[0]?.createdAt,
  );
  return out;
}

/** Messages that hold nothing but what a strip draws (plan cards, Helpers), and no strip of their
 * own: the transcript drops their rows (no empty gap). */
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
