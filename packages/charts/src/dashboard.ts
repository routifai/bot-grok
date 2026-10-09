import * as z from "zod";

import { ChartDocumentSchema } from "./document.js";

/**
 * What a `*.dashboard.json` artifact holds (written by the engine's `display_dashboard`, see
 * engine/omnigent/omnigent/superchat/charts/handlers.py): a title, KPI tiles and charts, each a
 * whole chart document (spec, source, rows), so the dashboard opens without the Computer.
 */
export const DashboardDocumentSchema = z.object({
  version: z.literal(1),
  title: z.string(),
  /** "grid" (default): two charts per row where there is room; "column": one per row. */
  layout: z.enum(["grid", "column"]).optional(),
  kpis: z.array(ChartDocumentSchema).max(6),
  charts: z
    .array(ChartDocumentSchema.extend({ wide: z.boolean().optional() }))
    .min(1)
    .max(12),
});
export type DashboardDocument = z.infer<typeof DashboardDocumentSchema>;
export type DashboardChart = DashboardDocument["charts"][number];

/** The dashboard in artifact bytes, or null when they are not a dashboard document. */
export function parseDashboardDocument(bytes: Uint8Array): DashboardDocument | null {
  try {
    const parsed = DashboardDocumentSchema.safeParse(
      JSON.parse(new TextDecoder("utf-8").decode(bytes)),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
