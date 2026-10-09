/* Portions modified from getnao/nao apps/backend/src/components/generate-chart.tsx and apps/backend/src/utils/generate-chart.ts@5bde830, Apache-2.0; changes: the SVG is stitched with string operations (no cheerio), `var(--token)` colors resolve against Nova's light and dark tokens, a KPI card gets its own SVG, the PNG is drawn by @resvg/resvg-js (MPL-2.0, used unmodified as a library). */

import { fileURLToPath } from "node:url";
import {
  CHART_FONT_STACK,
  type ChartDocument,
  type ChartSpec,
  computeKpiComparison,
  formatChartValue,
  type LegendEntry,
  prepareChart,
  resolveDataKey,
  VERTICAL_LEGEND_WIDTH,
} from "@nova/charts";
import { museDarkTokens, museLightTokens } from "@nova/ui-tokens";
import { Resvg } from "@resvg/resvg-js";
import { cloneElement } from "react";
import { renderToString } from "react-dom/server";

export type ChartTheme = "light" | "dark";
export type ChartImageFormat = "png" | "svg";

export interface RenderedChart {
  mimeType: "image/png" | "image/svg+xml";
  /** PNG bytes or the SVG text as UTF-8. */
  bytes: Buffer;
  width: number;
  height: number;
}

const FONT_FILES = ["DejaVuSans.ttf", "DejaVuSans-Bold.ttf"].map((name) =>
  fileURLToPath(new URL(`../../../assets/fonts/${name}`, import.meta.url)),
);

const THEMES: Record<ChartTheme, Record<string, string>> = {
  light: tokenMap(museLightTokens),
  dark: tokenMap(museDarkTokens),
};

function tokenMap(tokens: Record<string, unknown>): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [key, value] of Object.entries(tokens)) {
    if (typeof value === "string") map[key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)] = value;
  }
  return map;
}

/** `var(--background)` -> the theme's value, only inside attribute values (labels stay as typed). */
export function resolveTokens(svg: string, theme: ChartTheme): string {
  const tokens = THEMES[theme];
  return svg.replace(/="([^"]*var\(--[^"]*)"/g, (_match, value: string) => {
    const resolved = value.replace(/var\(--([a-z0-9-]+)\)/g, (whole, name: string) => {
      return tokens[name] ?? (name.startsWith("chart-") ? tokens["chart-1"] : undefined) ?? whole;
    });
    return `="${resolved}"`;
  });
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Truncates a label with an ellipsis on code points, so a surrogate pair is never split. */
export function truncateLabel(label: string, maxChars: number): string {
  const points = Array.from(label);
  if (points.length <= maxChars) return label;
  if (maxChars <= 1) return "…";
  return `${points.slice(0, maxChars - 1).join("")}…`;
}

const LEGEND_CHAR_WIDTH = 7;
const SWATCH = 10;

function legendText(x: number, y: number, label: string, theme: ChartTheme): string {
  return `<text x="${x}" y="${y}" dominant-baseline="middle" font-size="12" font-family="${escapeXml(CHART_FONT_STACK)}" fill="${THEMES[theme]["muted-foreground"]}">${escapeXml(label)}</text>`;
}

function horizontalLegend(
  entries: LegendEntry[],
  width: number,
  centerY: number,
  theme: ChartTheme,
) {
  const total = entries.reduce(
    (sum, e, i) =>
      sum + SWATCH + 6 + e.label.length * LEGEND_CHAR_WIDTH + (i < entries.length - 1 ? 16 : 0),
    0,
  );
  let x = Math.max((width - total) / 2, 8);
  const items = entries.map((entry) => {
    const swatch = `<rect x="${x}" y="${centerY - SWATCH / 2}" width="${SWATCH}" height="${SWATCH}" rx="2" fill="${escapeXml(entry.color)}"/>`;
    const text = legendText(x + SWATCH + 6, centerY, entry.label, theme);
    x += SWATCH + 6 + entry.label.length * LEGEND_CHAR_WIDTH + 16;
    return swatch + text;
  });
  return `<g>${items.join("")}</g>`;
}

function verticalLegend(
  entries: LegendEntry[],
  xOffset: number,
  rightEdge: number,
  height: number,
  theme: ChartTheme,
) {
  const lineHeight = 22;
  const textX = xOffset + SWATCH + 6;
  const maxChars = Math.max(1, Math.floor((rightEdge - textX - 12) / LEGEND_CHAR_WIDTH));
  let y = (height - entries.length * lineHeight) / 2 + lineHeight / 2;
  const items = entries.map((entry) => {
    const swatch = `<rect x="${xOffset}" y="${y - SWATCH / 2}" width="${SWATCH}" height="${SWATCH}" rx="2" fill="${escapeXml(entry.color)}"/>`;
    const text = legendText(textX, y, truncateLabel(entry.label, maxChars), theme);
    y += lineHeight;
    return swatch + text;
  });
  return `<g>${items.join("")}</g>`;
}

/** The `<svg>` element Recharts printed, from its first tag to its last. */
function innerSvg(html: string): string {
  const start = html.indexOf("<svg");
  const end = html.lastIndexOf("</svg>");
  if (start === -1 || end === -1) throw new Error("Recharts did not render SVG content");
  return html.slice(start, end + "</svg>".length);
}

function frame(svg: string, width: number, height: number, theme: ChartTheme, extra: string) {
  const open = svg.match(/^<svg[^>]*>/)?.[0] ?? "<svg>";
  const body = svg.slice(open.length, svg.length - "</svg>".length);
  const background = THEMES[theme].background;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="${background}"/>${body}${extra}</svg>`;
}

function kpiSvg(
  spec: ChartSpec,
  rows: ChartDocument["data"],
  width: number,
  height: number,
  theme: ChartTheme,
) {
  const tokens = THEMES[theme];
  const series = spec.series[0];
  const dataKey = resolveDataKey(rows, series?.data_key);
  const xKey = resolveDataKey(rows, spec.x_axis_key ?? undefined);
  const latest = rows[rows.length - 1]?.[dataKey];
  const value =
    typeof latest === "number"
      ? formatChartValue(latest, series?.value_format)
      : String(latest ?? "");
  const comparison = computeKpiComparison(rows, xKey, dataKey, spec.comparison_mode);
  const font = escapeXml(CHART_FONT_STACK);
  const centerX = width / 2;
  const colorOf = (direction: string, colored: boolean) =>
    !colored || direction === "flat"
      ? tokens["muted-foreground"]
      : direction === "up"
        ? tokens.success
        : tokens.destructive;
  const arrow = comparison
    ? comparison.direction === "up"
      ? "▲ "
      : comparison.direction === "down"
        ? "▼ "
        : ""
    : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="${width}" height="${height}" fill="${tokens.background}"/>` +
    `<text x="${centerX}" y="${height * 0.32}" text-anchor="middle" font-size="16" font-family="${font}" fill="${tokens["muted-foreground"]}">${escapeXml(truncateLabel(spec.title, 60))}</text>` +
    `<text x="${centerX}" y="${height * 0.58}" text-anchor="middle" font-size="${Math.round(Math.min(width / 7, 64))}" font-weight="500" font-family="${font}" fill="${tokens.foreground}">${escapeXml(value)}</text>` +
    (comparison
      ? `<text x="${centerX}" y="${height * 0.76}" text-anchor="middle" font-size="14" font-family="${font}" fill="${colorOf(comparison.direction, comparison.colored)}">${escapeXml(`${arrow}${comparison.valueText} vs. ${comparison.periodLabel}`)}</text>`
      : "") +
    `</svg>`
  );
}

/** A saved chart as an SVG string whose colors are concrete (no CSS variables left). */
export function renderChartSvg(
  document: Pick<ChartDocument, "spec" | "data">,
  options: { width: number; height: number; theme: ChartTheme },
): string {
  const { width, height, theme } = options;
  const { spec, data } = document;
  if (spec.chart_type === "kpi_card") return kpiSvg(spec, data, width, height, theme);
  const prepared = prepareChart(spec, data, {
    width,
    height,
    renderTitle: true,
    backgroundColor: "var(--background)",
  });
  const html = renderToString(cloneElement(prepared.chart, { width: prepared.chartWidth, height }));
  const svg = innerSvg(html);
  const vertical = prepared.legendLayout === "vertical";
  const legendHeight = !vertical && prepared.legend.length > 0 ? 24 : 0;
  const totalWidth = vertical ? prepared.chartWidth + VERTICAL_LEGEND_WIDTH : width;
  const totalHeight = height + legendHeight;
  const legend =
    prepared.legend.length === 0
      ? ""
      : vertical
        ? verticalLegend(prepared.legend, prepared.chartWidth + 12, totalWidth, height, theme)
        : horizontalLegend(prepared.legend, width, height + legendHeight / 2, theme);
  return resolveTokens(frame(svg, totalWidth, totalHeight, theme, legend), theme);
}

/** A saved chart as a PNG (2x for sharpness) or SVG. */
export function renderChart(
  document: Pick<ChartDocument, "spec" | "data">,
  options: { width: number; height: number; theme: ChartTheme; format: ChartImageFormat },
): RenderedChart {
  const svg = renderChartSvg(document, options);
  const size = svg.match(/width="(\d+(?:\.\d+)?)" height="(\d+(?:\.\d+)?)" viewBox/);
  const width = Math.round(Number(size?.[1] ?? options.width));
  const height = Math.round(Number(size?.[2] ?? options.height));
  if (options.format === "svg") {
    return { mimeType: "image/svg+xml", bytes: Buffer.from(svg, "utf8"), width, height };
  }
  const resvg = new Resvg(svg, {
    fitTo: { mode: "zoom", value: 2 },
    // Bundled DejaVu only: a slim image has no system fonts, and the same face on every host keeps
    // the thumbnails identical.
    font: {
      fontFiles: FONT_FILES,
      loadSystemFonts: false,
      defaultFontFamily: "DejaVu Sans",
      sansSerifFamily: "DejaVu Sans",
    },
  });
  return { mimeType: "image/png", bytes: Buffer.from(resvg.render().asPng()), width, height };
}
