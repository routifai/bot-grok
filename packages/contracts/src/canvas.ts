import * as z from "zod";

/**
 * Nova Canvas: a closed component catalog for the `show_canvas` agent tool (rendered by
 * apps/web instead of markdown tables, ad-hoc HTML, or a failing chart spec). The tree shape
 * here is the strict source of truth; `@aiden/core`'s canvas repair coerces whatever loose
 * JSON a model sends into this shape (or produces one corrected-example error) before a
 * block ever reaches this schema, so validation here can stay simple and exact.
 */

// A tree this large stopped being a "quick visual" long before the limit; trimmed by the
// repairer with a note rather than rejected, so an over-eager model still gets something.
export const CANVAS_MAX_NODES = 400;
export const CANVAS_MAX_DEPTH = 8;

const Gap = z.enum(["sm", "md", "lg"]);
const Align = z.enum(["start", "center", "end", "stretch"]);
const Tone = z.enum(["neutral", "info", "success", "warning"]);
const CalloutTone = z.enum(["info", "success", "warning"]);
const Trend = z.enum(["up", "down", "flat"]);
const ChartKind = z.enum(["bar", "line", "area", "stackedBar", "pie", "donut"]);
const TimelineStatus = z.enum(["done", "active", "upcoming"]);
const CellValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const StatItem = z.object({ label: z.string(), value: z.string() });
const KeyValueItem = z.object({ label: z.string(), value: z.string() });
const Source = z.object({
  title: z.string(),
  url: z.string(),
  /** Shown as plain text next to the source; never used to fetch a favicon. */
  domain: z.string().optional(),
});
const ChartPoint = z.object({ label: z.string(), value: z.number() });
const ChartSeries = z.object({ name: z.string().optional(), data: z.array(ChartPoint) });
const TableColumn = z.object({ id: z.string(), label: z.string() });
const TableCell = z.object({
  columnId: z.string(),
  value: CellValue,
  winner: z.boolean().optional(),
});
const TableRow = z.object({ label: z.string(), cells: z.array(TableCell) });
const RankingItem = z.object({
  rank: z.number().int().positive().optional(),
  name: z.string(),
  score: z.number().min(0).max(100).optional(),
  note: z.string().optional(),
});
const TimelineItem = z.object({
  date: z.string().optional(),
  title: z.string(),
  detail: z.string().optional(),
  status: TimelineStatus.optional(),
});
const ChecklistItem = z.object({ text: z.string(), done: z.boolean().optional() });
const ChoiceOption = z.object({ value: z.string(), label: z.string() });
const FormField = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    name: z.string(),
    label: z.string(),
    placeholder: z.string().optional(),
  }),
  z.object({
    kind: z.literal("select"),
    name: z.string(),
    label: z.string(),
    options: z.array(ChoiceOption).min(1),
  }),
  z.object({
    kind: z.literal("toggle"),
    name: z.string(),
    label: z.string(),
    default: z.boolean().optional(),
  }),
]);
export type CanvasFormField = z.infer<typeof FormField>;

const TabDef = z.object({ id: z.string(), label: z.string() });

/**
 * The catalog, by node `type`. Container types (stack, row, grid, section, tabs) carry
 * `children`; every other type is a leaf. Kept as a plain discriminated union (not
 * z.lazy on the whole object) so each variant's own props stay individually typed; the
 * recursive `children` field is threaded in via `CanvasNodeSchema` below.
 */
export const CANVAS_LEAF_TYPES = [
  "heading",
  "text",
  "badge",
  "stat",
  "key_value",
  "callout",
  "quote",
  "source_list",
  "item_card",
  "comparison_table",
  "ranking_list",
  "rating",
  "chart",
  "progress",
  "timeline",
  "checklist",
  "choice",
  "form",
  "link_button",
  "divider",
] as const;

export const CANVAS_CONTAINER_TYPES = ["stack", "row", "grid", "section", "tabs"] as const;

export const CANVAS_NODE_TYPES = [...CANVAS_CONTAINER_TYPES, ...CANVAS_LEAF_TYPES] as const;
export type CanvasNodeType = (typeof CANVAS_NODE_TYPES)[number];

/** JSON-safe value: every leaf's props are plain data (never a function, Date, etc.), which
 * also keeps a `ThreadMessage.blocks` array holding a canvas block assignable to Prisma's
 * `Json` column type — `unknown` here would break that structural check package-wide. */
export type CanvasJsonValue =
  | string
  | number
  | boolean
  | null
  | CanvasJsonValue[]
  | { [key: string]: CanvasJsonValue | undefined };

export interface CanvasNode {
  type: CanvasNodeType;
  props?: Record<string, CanvasJsonValue>;
  children?: CanvasNode[];
}

const props = <T extends z.ZodRawShape>(shape: T) => z.object(shape).partial().optional();

function leaf<Type extends string, PropsSchema extends z.ZodTypeAny>(
  type: Type,
  propsSchema: PropsSchema,
) {
  return z.object({ type: z.literal(type), props: propsSchema });
}

const LeafSchemas = {
  heading: leaf(
    "heading",
    z.object({
      text: z.string(),
      level: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    }),
  ),
  text: leaf("text", z.object({ text: z.string() })),
  badge: leaf("badge", z.object({ text: z.string(), tone: Tone.optional() })),
  stat: leaf(
    "stat",
    z.object({
      label: z.string(),
      value: z.union([z.string(), z.number()]),
      unit: z.string().optional(),
      delta: z.union([z.string(), z.number()]).optional(),
      trend: Trend.optional(),
    }),
  ),
  key_value: leaf("key_value", z.object({ items: z.array(KeyValueItem) })),
  callout: leaf(
    "callout",
    z.object({ tone: CalloutTone, title: z.string().optional(), text: z.string() }),
  ),
  quote: leaf("quote", z.object({ text: z.string(), attribution: z.string().optional() })),
  source_list: leaf("source_list", z.object({ sources: z.array(Source) })),
  item_card: leaf(
    "item_card",
    z.object({
      title: z.string(),
      subtitle: z.string().optional(),
      monogram: z.string().optional(),
      color: z.string().optional(),
      imageUrl: z.string().optional(),
      highlight: z.string().optional(),
      stats: z.array(StatItem).optional(),
      pros: z.array(z.string()).optional(),
      cons: z.array(z.string()).optional(),
      ctaLabel: z.string().optional(),
      ctaUrl: z.string().optional(),
    }),
  ),
  comparison_table: leaf(
    "comparison_table",
    z.object({
      columns: z.array(TableColumn).min(1),
      rows: z.array(TableRow).min(1),
      footer: z.string().optional(),
    }),
  ),
  ranking_list: leaf("ranking_list", z.object({ items: z.array(RankingItem).min(1) })),
  rating: leaf(
    "rating",
    z.object({
      value: z.number().min(0),
      max: z.number().positive().optional(),
      label: z.string().optional(),
    }),
  ),
  chart: leaf(
    "chart",
    z.object({
      kind: ChartKind,
      title: z.string().optional(),
      series: z.array(ChartSeries).min(1),
      unit: z.string().optional(),
    }),
  ),
  progress: leaf(
    "progress",
    z.object({
      label: z.string().optional(),
      value: z.number().min(0).max(100),
      tone: Tone.optional(),
    }),
  ),
  timeline: leaf("timeline", z.object({ items: z.array(TimelineItem).min(1) })),
  checklist: leaf("checklist", z.object({ items: z.array(ChecklistItem).min(1) })),
  choice: leaf(
    "choice",
    z.object({ question: z.string().optional(), options: z.array(ChoiceOption).min(2).max(6) }),
  ),
  form: leaf(
    "form",
    z.object({ fields: z.array(FormField).min(1), submitLabel: z.string().optional() }),
  ),
  link_button: leaf("link_button", z.object({ label: z.string(), url: z.string() })),
  divider: leaf("divider", z.object({})),
} as const;

const ContainerPropsSchemas = {
  stack: props({ direction: z.enum(["vertical", "horizontal"]), gap: Gap, align: Align }),
  row: props({ gap: Gap, wrap: z.boolean(), align: Align }),
  grid: props({ columns: z.number().int().min(1).max(6), minColumnWidth: z.number().positive() }),
  section: props({ title: z.string(), description: z.string() }),
  tabs: props({ tabs: z.array(TabDef).min(1) }),
} as const;

/** Recursive schema: each container variant's `children` refers back to this. */
export const CanvasNodeSchema: z.ZodType<CanvasNode> = z.lazy(
  () =>
    z.discriminatedUnion("type", [
      z.object({
        type: z.literal("stack"),
        props: ContainerPropsSchemas.stack,
        children: z.array(CanvasNodeSchema).default([]),
      }),
      z.object({
        type: z.literal("row"),
        props: ContainerPropsSchemas.row,
        children: z.array(CanvasNodeSchema).default([]),
      }),
      z.object({
        type: z.literal("grid"),
        props: ContainerPropsSchemas.grid,
        children: z.array(CanvasNodeSchema).default([]),
      }),
      z.object({
        type: z.literal("section"),
        props: ContainerPropsSchemas.section,
        children: z.array(CanvasNodeSchema).default([]),
      }),
      z.object({
        type: z.literal("tabs"),
        props: ContainerPropsSchemas.tabs,
        children: z.array(CanvasNodeSchema).default([]),
      }),
      LeafSchemas.heading,
      LeafSchemas.text,
      LeafSchemas.badge,
      LeafSchemas.stat,
      LeafSchemas.key_value,
      LeafSchemas.callout,
      LeafSchemas.quote,
      LeafSchemas.source_list,
      LeafSchemas.item_card,
      LeafSchemas.comparison_table,
      LeafSchemas.ranking_list,
      LeafSchemas.rating,
      LeafSchemas.chart,
      LeafSchemas.progress,
      LeafSchemas.timeline,
      LeafSchemas.checklist,
      LeafSchemas.choice,
      LeafSchemas.form,
      LeafSchemas.link_button,
      LeafSchemas.divider,
    ]) as unknown as z.ZodType<CanvasNode>,
);

/** Node types whose interaction (a pick, or a form submit) needs an answer back from the
 * person before the agent can continue — `show_canvas` pauses the run for these. */
export function canvasNodeIsInteractive(node: CanvasNode): boolean {
  if (node.type === "choice" || node.type === "form") return true;
  return (node.children ?? []).some(canvasNodeIsInteractive);
}

export function canvasTreeIsInteractive(tree: CanvasNode): boolean {
  return canvasNodeIsInteractive(tree);
}
