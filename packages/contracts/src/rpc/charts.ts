import { oc } from "@orpc/contract";
import * as z from "zod";
import { Id } from "../ids.js";

/** A chart is a JSON artifact whose file name ends with this (the engine uses the same marker). */
export const CHART_NAME_SUFFIX = ".chart.json";

/** True when an artifact file name marks a chart (`*.chart.json`, any case). */
export function isChartArtifactName(name: string): boolean {
  return name.length > CHART_NAME_SUFFIX.length && name.toLowerCase().endsWith(CHART_NAME_SUFFIX);
}

/** A dashboard (KPI tiles and charts shown as one) is a JSON artifact named `*.dashboard.json`. */
export const DASHBOARD_NAME_SUFFIX = ".dashboard.json";

/** True when an artifact file name marks a dashboard (`*.dashboard.json`, any case). */
export function isDashboardArtifactName(name: string): boolean {
  return (
    name.length > DASHBOARD_NAME_SUFFIX.length && name.toLowerCase().endsWith(DASHBOARD_NAME_SUFFIX)
  );
}

/** A dashboard page: one self-contained HTML file of KPIs and Chart.js charts, built in the
 * Computer by `nova-dashboard` and named `*.dashboard.html`. */
export const DASHBOARD_PAGE_NAME_SUFFIX = ".dashboard.html";

/** True when an artifact file name marks a dashboard page (`*.dashboard.html`, any case). */
export function isDashboardPageName(name: string): boolean {
  return (
    name.length > DASHBOARD_PAGE_NAME_SUFFIX.length &&
    name.toLowerCase().endsWith(DASHBOARD_PAGE_NAME_SUFFIX)
  );
}

export const CHART_THUMBNAIL_FORMATS = ["png", "svg"] as const;
export const CHART_THUMBNAIL_THEMES = ["light", "dark"] as const;

export const ChartThumbnailSchema = z.object({
  mimeType: z.enum(["image/png", "image/svg+xml"]),
  /** The image bytes, base64. */
  contentBase64: z.string(),
  width: z.number().int(),
  height: z.number().int(),
});
export type ChartThumbnail = z.infer<typeof ChartThumbnailSchema>;

export const chartsContract = {
  charts: {
    /** A saved chart (a `*.chart.json` artifact, or a dashboard's first chart) drawn
     * server-side as a PNG or SVG. */
    thumbnail: oc
      .input(
        z.object({
          artifactId: Id,
          format: z.enum(CHART_THUMBNAIL_FORMATS).default("png"),
          theme: z.enum(CHART_THUMBNAIL_THEMES).default("light"),
          width: z.number().int().min(160).max(800).default(640),
          height: z.number().int().min(100).max(500).default(400),
        }),
      )
      .output(ChartThumbnailSchema),
  },
};
