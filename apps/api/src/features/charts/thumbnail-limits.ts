import type { ChartDocument } from "@nova/charts";

/** A thumbnail is a few hundred pixels wide: more points than this cannot be told apart. */
export const THUMBNAIL_MAX_POINTS = 500;
export const THUMBNAIL_MAX_SERIES = 12;

/**
 * The document cut down for a small image: at most 500 rows (evenly spaced, the last one always
 * kept so the latest value still shows) and 12 series. A KPI card keeps only the two rows its
 * comparison reads. The saved chart is untouched; this is only what the thumbnail draws.
 */
export function limitForThumbnail<T extends Pick<ChartDocument, "spec" | "data">>(document: T): T {
  const { spec, data } = document;
  const series = spec.series.slice(0, THUMBNAIL_MAX_SERIES);
  let rows = data;
  if (spec.chart_type === "kpi_card") {
    rows = data.slice(-2);
  } else if (data.length > THUMBNAIL_MAX_POINTS) {
    const step = (data.length - 1) / (THUMBNAIL_MAX_POINTS - 1);
    rows = Array.from(
      { length: THUMBNAIL_MAX_POINTS },
      (_, i) => data[Math.round(i * step)],
    ).filter((row): row is (typeof data)[number] => row !== undefined);
  }
  return { ...document, spec: { ...spec, series }, data: rows };
}
