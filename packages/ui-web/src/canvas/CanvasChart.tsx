import { useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { seriesColor } from "./canvas-colors.js";
import { useContainerWidth } from "./use-container-width.js";
import { useReducedMotion } from "./use-reduced-motion.js";

type Point = { label: string; value: number };
type Series = { name?: string; data: Point[] };

const MARGIN = { top: 28, right: 12, bottom: 28, left: 44 };
/** A true zero still gets a visible sliver at the baseline; an invisible bar reads as
 * missing data, not "zero". */
const ZERO_BAR_STUB = 2;

function formatNumber(value: number, unit?: string): string {
  const decimals = Math.abs(value) < 10 && !Number.isInteger(value) ? 1 : 0;
  const formatted = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
  return unit ? `${unit}${formatted}` : formatted;
}

/** Rounds a raw axis step up to a "nice" 1/2/5×10^n increment, the way every readable
 * chart axis does, so labels read $50/$100/$150 instead of $51.96/$103.92/$155.88. */
function niceStep(rawStep: number): number {
  if (rawStep <= 0) return 1;
  const exponent = Math.floor(Math.log10(rawStep));
  const base = rawStep / 10 ** exponent;
  const niceBase = base <= 1 ? 1 : base <= 2 ? 2 : base <= 5 ? 5 : 10;
  return niceBase * 10 ** exponent;
}

/** Nice-rounded tick values spanning at least [min, max], evenly stepped. */
function niceTicks(min: number, max: number, targetCount: number): number[] {
  if (min === max) return [min];
  const step = niceStep((max - min) / Math.max(1, targetCount - 1));
  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let value = niceMin; value <= niceMax + step / 1e6; value += step) ticks.push(value);
  return ticks;
}

/** Text-only summary of every point, read by screen readers instead of the SVG shapes. */
function ChartDataTable({ series, unit }: { series: Series[]; unit?: string }) {
  const { t } = useLingui();
  return (
    <table className="sr-only">
      <tbody>
        {series.map((s, seriesIndex) => (
          <tr key={s.name ?? seriesIndex}>
            <th scope="row">{s.name || t`Value`}</th>
            {s.data.map((point) => (
              <td key={point.label}>
                {point.label}: {formatNumber(point.value, unit)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ChartAxes({
  width,
  height,
  ticks,
  categories,
  unit,
}: {
  width: number;
  height: number;
  ticks: number[];
  categories: string[];
  unit?: string;
}) {
  const plotWidth = width - MARGIN.left - MARGIN.right;
  const plotHeight = height - MARGIN.top - MARGIN.bottom;
  const categoryWidth = plotWidth / Math.max(1, categories.length);
  return (
    <g>
      {ticks.map((tick, index) => {
        const y = MARGIN.top + plotHeight * (1 - index / (ticks.length - 1 || 1));
        return (
          <g key={tick}>
            <line
              x1={MARGIN.left}
              x2={width - MARGIN.right}
              y1={y}
              y2={y}
              className="stroke-border"
              strokeWidth={1}
            />
            <text
              x={MARGIN.left - 8}
              y={y}
              textAnchor="end"
              dominantBaseline="middle"
              className="fill-muted-foreground text-[11px] tabular-nums"
            >
              {formatNumber(tick, unit)}
            </text>
          </g>
        );
      })}
      {categories.map((label, index) => (
        <text
          key={label}
          x={MARGIN.left + categoryWidth * (index + 0.5)}
          y={height - 8}
          textAnchor="middle"
          className="fill-muted-foreground text-[11px]"
        >
          {label.length > 12 ? `${label.slice(0, 11)}…` : label}
        </text>
      ))}
    </g>
  );
}

function BarChart({
  width,
  height,
  series,
  unit,
  stacked,
}: {
  width: number;
  height: number;
  series: Series[];
  unit?: string;
  stacked: boolean;
}) {
  const reducedMotion = useReducedMotion();
  const [grown, setGrown] = useState(reducedMotion);
  useEffect(() => {
    if (reducedMotion) return;
    const id = requestAnimationFrame(() => setGrown(true));
    return () => cancelAnimationFrame(id);
  }, [reducedMotion]);

  const plotWidth = width - MARGIN.left - MARGIN.right;
  const plotHeight = height - MARGIN.top - MARGIN.bottom;
  const categories = series[0]?.data.map((point) => point.label) ?? [];
  const stackTotals = categories.map((_, index) =>
    series.reduce((sum, s) => sum + (s.data[index]?.value ?? 0), 0),
  );
  const rawMax = Math.max(
    1,
    stacked
      ? Math.max(...stackTotals)
      : Math.max(...series.flatMap((s) => s.data.map((p) => p.value))),
  );
  const ticks = niceTicks(0, rawMax, 4);
  // Bars scale against the rounded axis top, not the raw max, so the tallest bar lines up
  // with its nearest gridline instead of always touching the plot's edge.
  const maxValue = ticks[ticks.length - 1] ?? rawMax;
  const categoryWidth = plotWidth / Math.max(1, categories.length);
  const groupWidth = categoryWidth * 0.68;
  const barWidth = stacked ? groupWidth : groupWidth / series.length;
  const baselineY = MARGIN.top + plotHeight;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="presentation" className="block w-full">
      <ChartAxes width={width} height={height} ticks={ticks} categories={categories} unit={unit} />
      {categories.map((_, categoryIndex) => {
        let stackedY = baselineY;
        const total = stackTotals[categoryIndex] ?? 0;
        return (
          <g key={categoryIndex}>
            {series.map((s, seriesIndex) => {
              const value = s.data[categoryIndex]?.value ?? 0;
              const rawHeight = (value / maxValue) * plotHeight;
              const barHeight = value === 0 ? ZERO_BAR_STUB : rawHeight;
              const x = stacked
                ? MARGIN.left + categoryWidth * categoryIndex + (categoryWidth - barWidth) / 2
                : MARGIN.left +
                  categoryWidth * categoryIndex +
                  (categoryWidth - groupWidth) / 2 +
                  barWidth * seriesIndex;
              const y = stacked ? stackedY - barHeight : baselineY - barHeight;
              if (stacked) stackedY -= barHeight;
              const color = seriesColor(seriesIndex, series.length);
              // A single series labels every bar; a stack labels only its total (once),
              // above the topmost segment, to avoid stamping a number on every sliver.
              const showLabel = stacked ? seriesIndex === series.length - 1 : true;
              const labelValue = stacked ? total : value;
              const labelY = (stacked ? stackedY : y) - 6;
              return (
                <g key={seriesIndex}>
                  <rect
                    x={x}
                    y={grown ? y : baselineY}
                    width={barWidth}
                    height={grown ? barHeight : 0}
                    rx={3}
                    className={color ? undefined : "fill-primary"}
                    style={{
                      ...(color ? { fill: color } : {}),
                      transition: "y 600ms ease-out, height 600ms ease-out",
                    }}
                  >
                    <title>
                      {s.name ? `${s.name} — ` : ""}
                      {categories[categoryIndex]}: {formatNumber(value, unit)}
                    </title>
                  </rect>
                  {showLabel ? (
                    <text
                      x={x + barWidth / 2}
                      y={grown ? labelY : baselineY - 6}
                      textAnchor="middle"
                      className="fill-foreground text-[11px] font-medium tabular-nums"
                      style={{ transition: "y 600ms ease-out", opacity: grown ? 1 : 0 }}
                    >
                      {formatNumber(labelValue, unit)}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </g>
        );
      })}
      <ChartDataTable series={series} unit={unit} />
    </svg>
  );
}

function LineChart({
  width,
  height,
  series,
  unit,
  filled,
}: {
  width: number;
  height: number;
  series: Series[];
  unit?: string;
  filled: boolean;
}) {
  const reducedMotion = useReducedMotion();
  const [visible, setVisible] = useState(reducedMotion);
  useEffect(() => {
    if (reducedMotion) return;
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, [reducedMotion]);

  const plotWidth = width - MARGIN.left - MARGIN.right;
  const plotHeight = height - MARGIN.top - MARGIN.bottom;
  const categories = series[0]?.data.map((point) => point.label) ?? [];
  const values = series.flatMap((s) => s.data.map((p) => p.value));
  const rawMin = Math.min(0, ...values);
  const rawMax = Math.max(1, ...values);
  const ticks = niceTicks(rawMin, rawMax, 4);
  const domainMin = ticks[0] ?? rawMin;
  const domainMax = ticks[ticks.length - 1] ?? rawMax;
  const categoryWidth = plotWidth / Math.max(1, categories.length - 1 || 1);
  const scaleY = (value: number) =>
    MARGIN.top + plotHeight * (1 - (value - domainMin) / (domainMax - domainMin));
  const baseline = scaleY(Math.max(domainMin, 0));

  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="presentation" className="block w-full">
      <ChartAxes width={width} height={height} ticks={ticks} categories={categories} unit={unit} />
      {series.map((s, seriesIndex) => {
        const color = seriesColor(seriesIndex, series.length);
        const points = s.data.map((point, index) => ({
          x: MARGIN.left + categoryWidth * index,
          y: scaleY(point.value),
        }));
        const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
        const areaPath = `${linePath} L ${points[points.length - 1]?.x ?? 0} ${baseline} L ${points[0]?.x ?? 0} ${baseline} Z`;
        return (
          <g
            key={s.name ?? seriesIndex}
            style={{ opacity: visible ? 1 : 0, transition: "opacity 500ms ease-out" }}
          >
            {filled ? (
              <path
                d={areaPath}
                className={color ? undefined : "fill-primary/15"}
                style={color ? { fill: color, opacity: 0.18 } : undefined}
              />
            ) : null}
            <path
              d={linePath}
              fill="none"
              strokeWidth={2}
              className={color ? undefined : "stroke-primary"}
              style={color ? { stroke: color } : undefined}
            />
            {points.map((p, index) => (
              <circle
                key={index}
                cx={p.x}
                cy={p.y}
                r={3}
                className={color ? undefined : "fill-primary"}
                style={color ? { fill: color } : undefined}
              >
                <title>
                  {s.name ? `${s.name} — ` : ""}
                  {categories[index]}: {formatNumber(s.data[index]?.value ?? 0, unit)}
                </title>
              </circle>
            ))}
          </g>
        );
      })}
      <ChartDataTable series={series} unit={unit} />
    </svg>
  );
}

function polarPoint(cx: number, cy: number, r: number, angle: number) {
  return { x: cx + r * Math.cos(angle - Math.PI / 2), y: cy + r * Math.sin(angle - Math.PI / 2) };
}

function arcPath(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  start: number,
  end: number,
): string {
  const largeArc = end - start > Math.PI ? 1 : 0;
  const startOuter = polarPoint(cx, cy, rOuter, end);
  const endOuter = polarPoint(cx, cy, rOuter, start);
  if (rInner <= 0) {
    return `M ${cx} ${cy} L ${startOuter.x} ${startOuter.y} A ${rOuter} ${rOuter} 0 ${largeArc} 0 ${endOuter.x} ${endOuter.y} Z`;
  }
  const startInner = polarPoint(cx, cy, rInner, start);
  const endInner = polarPoint(cx, cy, rInner, end);
  return [
    `M ${startOuter.x} ${startOuter.y}`,
    `A ${rOuter} ${rOuter} 0 ${largeArc} 0 ${endOuter.x} ${endOuter.y}`,
    `L ${endInner.x} ${endInner.y}`,
    `A ${rInner} ${rInner} 0 ${largeArc} 1 ${startInner.x} ${startInner.y}`,
    "Z",
  ].join(" ");
}

function PieChart({
  size,
  series,
  unit,
  donut,
}: {
  size: number;
  series: Series[];
  unit?: string;
  donut: boolean;
}) {
  const reducedMotion = useReducedMotion();
  const [visible, setVisible] = useState(reducedMotion);
  useEffect(() => {
    if (reducedMotion) return;
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, [reducedMotion]);

  const data = series[0]?.data ?? [];
  const total = Math.max(
    1,
    data.reduce((sum, point) => sum + Math.max(0, point.value), 0),
  );
  const cx = size / 2;
  const cy = size / 2;
  const rOuter = size / 2 - 10;
  const rInner = donut ? rOuter * 0.6 : 0;
  let angle = 0;
  const slices = data.map((point, index) => {
    const start = angle;
    const fraction = Math.max(0, point.value) / total;
    angle += fraction * Math.PI * 2;
    return {
      point,
      start,
      end: angle,
      color: seriesColor(index, data.length) ?? seriesColor(0, 2),
    };
  });

  return (
    <div className="flex flex-wrap items-center gap-6">
      <svg
        viewBox={`0 0 ${size} ${size}`}
        role="presentation"
        className="shrink-0"
        style={{
          width: size,
          height: size,
          opacity: visible ? 1 : 0,
          transition: "opacity 500ms ease-out",
        }}
      >
        {slices.map((slice) => (
          <path
            key={slice.point.label}
            d={arcPath(cx, cy, rOuter, rInner, slice.start, slice.end)}
            style={{ fill: slice.color }}
          >
            <title>
              {slice.point.label}: {formatNumber(slice.point.value, unit)}
            </title>
          </path>
        ))}
      </svg>
      <ul className="flex flex-col gap-1.5">
        {slices.map((slice) => (
          <li
            key={slice.point.label}
            className="flex items-center gap-2 text-[12.5px] text-foreground/85"
          >
            <span
              aria-hidden="true"
              className="size-2.5 shrink-0 rounded-full"
              style={{ background: slice.color }}
            />
            {slice.point.label}
            <span className="tabular-nums text-muted-foreground">
              {formatNumber(slice.point.value, unit)}
            </span>
          </li>
        ))}
      </ul>
      <ChartDataTable series={series} unit={unit} />
    </div>
  );
}

/** Below this the axis, tick labels, and bar values stop being legible — enforced
 * regardless of how narrow the host container is. */
const MIN_CHART_HEIGHT = 180;
const MAX_CHART_HEIGHT = 320;
const FALLBACK_CHART_WIDTH = 560;

export function CanvasChart({
  kind,
  title,
  series,
  unit,
}: {
  kind: "bar" | "line" | "area" | "stackedBar" | "pie" | "donut";
  title?: string;
  series: Series[];
  unit?: string;
}) {
  const [containerRef, width] = useContainerWidth(FALLBACK_CHART_WIDTH);
  const height = Math.min(MAX_CHART_HEIGHT, Math.max(MIN_CHART_HEIGHT, Math.round(width * 0.4)));
  const summary = `${kind} chart${title ? ` — ${title}` : ""}, ${series[0]?.data.length ?? 0} categories`;
  return (
    <figure
      ref={containerRef}
      className="m-0 min-w-0 rounded-2xl border border-border bg-card p-4"
      aria-label={summary}
    >
      {title ? (
        <figcaption className="mb-2 text-[13.5px] font-semibold text-foreground">
          {title}
        </figcaption>
      ) : null}
      {kind === "bar" || kind === "stackedBar" ? (
        <BarChart
          width={width}
          height={height}
          series={series}
          unit={unit}
          stacked={kind === "stackedBar"}
        />
      ) : null}
      {kind === "line" || kind === "area" ? (
        <LineChart
          width={width}
          height={height}
          series={series}
          unit={unit}
          filled={kind === "area"}
        />
      ) : null}
      {kind === "pie" || kind === "donut" ? (
        <PieChart
          size={Math.min(height, 220)}
          series={series}
          unit={unit}
          donut={kind === "donut"}
        />
      ) : null}
    </figure>
  );
}
