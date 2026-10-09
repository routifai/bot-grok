import * as z from "zod";

import { ChartSpecSchema } from "./spec.js";

/** Largest data snapshot a chart carries (the engine caps it the same). */
export const CHART_MAX_ROWS = 5000;

/**
 * What a `*.chart.json` artifact holds (written by the engine's `display_chart`, see
 * engine/omnigent/omnigent/superchat/charts/handlers.py): the spec, where the rows came from, and
 * a snapshot of the rows, so a chart opens without the Computer.
 */
export const ChartDocumentSchema = z.object({
  version: z.literal(1),
  spec: ChartSpecSchema,
  source: z.object({
    file: z.string(),
    path: z.string(),
    columns: z.array(z.string()),
    rows: z.number().int(),
    truncated: z.boolean(),
    /** The file held more rows than the engine reads; the chart covers only the first of them. */
    read_cut: z.boolean().optional(),
  }),
  data: z.array(z.record(z.string(), z.unknown())).max(CHART_MAX_ROWS),
});
export type ChartDocument = z.infer<typeof ChartDocumentSchema>;

/** The document in artifact bytes, or null when they are not a chart document. */
export function parseChartDocument(bytes: Uint8Array): ChartDocument | null {
  try {
    const parsed = ChartDocumentSchema.safeParse(
      JSON.parse(new TextDecoder("utf-8").decode(bytes)),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
