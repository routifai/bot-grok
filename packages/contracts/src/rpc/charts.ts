import { oc } from "@orpc/contract";
import * as z from "zod";
import { Id } from "../ids.js";

/** A chart is a JSON artifact whose file name ends with this (the engine uses the same marker). */
export const CHART_NAME_SUFFIX = ".chart.json";

/** True when an artifact file name marks a chart (`*.chart.json`, any case). */
export function isChartArtifactName(name: string): boolean {
  return name.length > CHART_NAME_SUFFIX.length && name.toLowerCase().endsWith(CHART_NAME_SUFFIX);
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
    /** A saved chart (a `*.chart.json` artifact) drawn server-side as a PNG or SVG. */
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
