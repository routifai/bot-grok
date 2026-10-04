import * as z from "zod";

// Reply cards: the Muse's `render_card` engine tool (engine/omnigent/omnigent/tools/builtins/
// render_card.py) names a card kind and a small data payload; clients draw it from their own
// catalog (apps/web/src/components/cards). The engine validates with the same shapes, so these
// schemas are the client's second line: a card that does not parse renders its `fallback`.

const Text = z.string().max(2000);
const Url = z.string().max(2048);

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
  plan: z.object({
    items: z
      .array(z.object({ text: Text, status: z.enum(["todo", "doing", "done"]) }))
      .min(1)
      .max(50),
  }),
  ask: z.object({
    question: Text,
    options: z
      .array(z.object({ id: Text, label: Text }))
      .min(1)
      .max(8),
    allowFreeText: z.boolean().optional(),
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
  chart: z.object({
    kind: z.enum(["line", "bar"]),
    x: z.array(Text).min(1).max(120),
    series: z
      .array(z.object({ name: Text, values: z.array(z.number()).min(1).max(120) }))
      .min(1)
      .max(4),
    unit: Text.optional(),
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
  }),
  /** The Muse's `vault_request_secret`: the person types a login into the card, which posts it
   * straight to the vault. Only the request id travels in chat; never a value. */
  secure_entry: z.object({
    requestId: Text,
    name: Text,
    site: Text,
    reason: Text.optional(),
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
  // z.any keeps the inferred type JSON-assignable for persistence (like ChartBlock).
  data: z.record(z.string(), z.any()),
  fallback: z.string(),
  pending: z.boolean().optional(),
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
