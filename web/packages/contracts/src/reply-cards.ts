import * as z from "zod";

// Reply cards: the Muse's `render_card` engine tool (engine/omnigent/tools/builtins/
// render_card.py) names a card kind and a small data payload; clients draw it from their own
// catalog (web/app/src/components/cards). `ask_clarification` (an `ask` card) and
// `suggest_follow_ups` (a `follow_ups` card) travel the same path. The engine validates with the same shapes, so these
// schemas are the client's second line: a card that does not parse renders its `fallback`.

const Text = z.string().max(2000);
const Url = z.string().max(2048);

/** A plan step as the engine reads it (ADR 0027): `claimed` is the model's tick with nothing
 * behind it (not done), `not_checked` a check step nothing ran, `stopped` a step left doing once
 * nothing runs. */
export const PlanStateSchema = z.enum([
  "todo",
  "doing",
  "done",
  "claimed",
  "failed",
  "not_checked",
  "stopped",
]);
export type PlanState = z.infer<typeof PlanStateSchema>;

/** What a plan item reads: the engine's `state`, else (a plan from before the engine read it)
 * the model's `status`. */
export function planItemState(item: { status?: PlanState; state?: PlanState }): PlanState {
  return item.state ?? item.status ?? "todo";
}

export const ReplyCardData = {
  sources: z.object({
    items: z
      .array(z.object({ title: Text, url: Url, snippet: Text.optional() }))
      .min(1)
      .max(50),
  }),
  compare: z.object({
    columns: z.array(Text).min(1).max(8),
    rows: z
      .array(z.object({ label: Text, cells: z.array(Text).min(1).max(8) }))
      .min(1)
      .max(50),
  }),
  /** The living plan (ADR 0023, ADR 0027). `status` is the model's word at creation only; the
   * engine's `state` (from the evidence it holds) is what the person reads. */
  plan: z.object({
    items: z
      .array(
        z.object({
          text: Text,
          status: z.enum(["todo", "doing", "done"]).optional(),
          /** The step in the present tense, shown while it is doing ("Building the deck"). */
          active: Text.optional(),
          /** Lenient: an owner it does not know reads as "me". */
          owner: z.enum(["me", "helper"]).optional().catch("me"),
          /** The evidence that makes the step done (engine `tasks.record.DONE_WHEN`). */
          done_when: Text.optional(),
          /** Lenient: a state it does not know reads as to do, never a broken card. */
          state: PlanStateSchema.optional().catch("todo"),
        }),
      )
      .min(1)
      .max(50),
  }),
  ask: z.object({
    question: Text,
    options: z
      .array(
        z.object({
          id: Text,
          label: Text,
          /** What the client draws on the option (a deck theme's thumbnail); unknown kinds
           * render as a plain button. */
          preview: z.object({ kind: Text, id: Text }).optional(),
        }),
      )
      .min(1)
      .max(8),
    allowFreeText: z.boolean().optional(),
  }),
  /** The Muse's `suggest_follow_ups`: 1-3 next messages shown as quiet chips under the latest
   * answer. Clicking one sends it as the person's message. */
  follow_ups: z.object({
    suggestions: z.array(Text.min(1).max(120)).min(1).max(3),
  }),
  quote: z.object({
    symbol: Text,
    name: Text.optional(),
    price: z.number(),
    currency: Text.optional(),
    change: z.number().optional(),
    changePct: z.number().optional(),
    asOf: Text.optional(),
    source: Text.optional(),
  }),
  person: z.object({
    name: Text,
    role: Text.optional(),
    org: Text.optional(),
    email: Text.optional(),
    phone: Text.optional(),
    url: Url.optional(),
  }),
  file: z.object({
    name: Text,
    url: Url.optional(),
    kind: Text.optional(),
    size: z.number().nonnegative().optional(),
    /** Set for a file the Muse saved with `artifact_save`: the engine artifact the card opens. */
    artifactId: Text.optional(),
    version: z.number().int().positive().optional(),
    versions: z.number().int().positive().optional(),
    /** The person delivered this file themselves (a panel export), not the Muse. */
    byYou: z.boolean().optional(),
  }),
  /** The Muse's `vault_request_secret`: the person types a login into the card, which posts it
   * straight to the vault. Only the request id travels in chat; never a value. */
  secure_entry: z.object({
    requestId: Text,
    name: Text,
    site: Text,
    reason: Text.optional(),
  }),
  /** The pages a `files_search` found (the engine's transcript adds it under the answer): small
   * page-thumbnail chips that open the file at that page. Never rendered by the Muse itself. */
  passages: z.object({
    items: z
      .array(
        z
          .object({
            /** The file in the host's index; `artifactId` only on rows from before. */
            fileId: Text.optional(),
            artifactId: Text.optional(),
            /** The file's workspace path; opens it in the host when it is not a Library artifact. */
            path: Text.optional(),
            name: Text,
            page: z.number().int().positive(),
            hasThumbnail: z.boolean().optional(),
          })
          .refine((item) => Boolean(item.fileId || item.artifactId), {
            message: "A passage needs a fileId or artifactId",
          }),
      )
      .min(1)
      .max(12),
  }),
  progress: z.object({
    label: Text,
    value: z.number().min(0).max(100),
    status: z.enum(["running", "done", "failed"]),
  }),
} as const;

export type ReplyCardKind = keyof typeof ReplyCardData;
export type ReplyCardDataOf<K extends ReplyCardKind> = z.infer<(typeof ReplyCardData)[K]>;

/** A validated card, ready for the catalog: `kind` narrows `data`. */
export type ParsedReplyCard = {
  [K in ReplyCardKind]: { kind: K; data: ReplyCardDataOf<K> };
}[ReplyCardKind];

/** The persisted block. `card` and `data` stay loose so an unknown kind or a malformed payload
 * never invalidates the whole message; `parseReplyCard` is the strict gate. `pending` marks a
 * tool call whose result has not arrived yet (the client shows a skeleton). */
export const ReplyCardBlock = z.object({
  kind: z.literal("reply_card"),
  card: z.string(),
  id: z.string().optional(),
  title: z.string().optional(),
  // z.any keeps the inferred type JSON-assignable for persistence.
  data: z.record(z.string(), z.any()),
  fallback: z.string(),
  pending: z.boolean().optional(),
  /** A `plan` card: how many leading done steps fold away, as the engine counts them (ADR 0027). */
  fold: z.number().int().nonnegative().optional(),
});
export type ReplyCardBlock = z.infer<typeof ReplyCardBlock>;

export function isReplyCardKind(value: string): value is ReplyCardKind {
  return Object.hasOwn(ReplyCardData, value);
}

/** Strictly parses a block's payload against its kind's schema; `null` means "draw the fallback". */
export function parseReplyCard(
  block: Pick<ReplyCardBlock, "card" | "data">,
): ParsedReplyCard | null {
  if (!isReplyCardKind(block.card)) return null;
  const parsed = ReplyCardData[block.card].safeParse(block.data);
  return parsed.success ? ({ kind: block.card, data: parsed.data } as ParsedReplyCard) : null;
}
