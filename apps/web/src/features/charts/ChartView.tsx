import { t } from "@lingui/core/macro";
import {
  type ChartConfig,
  ChartConfigProvider,
  type ChartDocument,
  ChartLegendContent,
  ChartTooltipContent,
  computeKpiComparison,
  formatChartValue,
  isPercentStackedChartType,
  Legend,
  labelize,
  paletteColor,
  prepareChart,
  ResponsiveContainer,
  resolveDataKey,
  Tooltip,
} from "@nova/charts";
import { cn } from "@nova/ui-web";
import {
  type ComponentProps,
  cloneElement,
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/** Width the chart is laid out for before its frame has been measured. */
const DEFAULT_WIDTH = 640;
const SIDE_LEGEND_MIN_WIDTH = 480;

/** The element's content width, kept current as it resizes (0 until measured). */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    setWidth(Math.round(node.getBoundingClientRect().width));
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      // Whole pixels, so sub-pixel jitter does not re-lay the chart out.
      if (next !== undefined) setWidth(Math.round(next));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** The legend; with `onToggle`, each entry switches its series on and off. */
function ToggleLegend({
  off,
  onSwitch,
  payload,
  ...props
}: Omit<ComponentProps<typeof ChartLegendContent>, "hidden"> & {
  off: ReadonlySet<string>;
  onSwitch?: (key: string) => void;
}) {
  return (
    <ChartLegendContent
      {...props}
      cn={cn}
      // Long legends wrap inside the card instead of running past its edges.
      className="flex-wrap gap-x-4 gap-y-1"
      payload={payload?.map((item) => ({ ...item, isHidden: off.has(String(item.dataKey)) }))}
      onItemClick={onSwitch}
    />
  );
}

/** The source line: says which rows a cut chart keeps (a date chart keeps the newest). */
export function sourceCaption(source: ChartDocument["source"], dated: boolean): string {
  if (source.read_cut) return t`Source: ${source.file} (long file, only its start was read)`;
  if (!source.truncated) return t`Source: ${source.file}`;
  return dated
    ? t`Source: ${source.file} (latest ${source.rows} rows)`
    : t`Source: ${source.file} (first ${source.rows} rows)`;
}

function configFor(
  document: Pick<ChartDocument, "spec" | "data">,
  categories: string[],
  palette?: readonly string[],
) {
  const config: ChartConfig = {};
  document.spec.series.forEach((series, index) => {
    config[series.data_key] = {
      label: series.label ?? series.data_key,
      color: series.color ?? paletteColor(palette, series.data_key, index),
      isTotal: series.is_total,
      valueFormat: series.value_format,
    };
  });
  const shares = categories.length > 0 ? pieShares(document) : null;
  categories.forEach((category, index) => {
    const share = shares?.get(category);
    config[category] = {
      label:
        share === undefined ? (
          category
        ) : (
          <>
            {category}
            <span className="ms-1.5 text-muted-foreground/70 tabular-nums">{share}</span>
          </>
        ),
      color: paletteColor(palette, category, index),
    };
  });
  return config;
}

/** Each pie slice's share of the whole ("42.1%"), by its label. */
function pieShares({ spec, data }: Pick<ChartDocument, "spec" | "data">): Map<string, string> {
  const xKey = resolveDataKey(data, spec.x_axis_key ?? undefined);
  const valueKey = resolveDataKey(data, spec.series[0]?.data_key);
  const values = data.map((row) => [labelize(row[xKey]), Number(row[valueKey])] as const);
  const total = values.reduce((sum, [, value]) => sum + (value > 0 ? value : 0), 0);
  const shares = new Map<string, string>();
  if (total <= 0) return shares;
  for (const [label, value] of values) {
    if (value > 0) shares.set(label, `${((value / total) * 100).toFixed(1)}%`);
  }
  return shares;
}

/**
 * A saved chart: its title, the interactive chart (hover tooltip, legend) in the Nova tokens, and
 * the source line. `height` is the plot's height in px, or `"fill"` to use the parent's;
 * `palette` colors the series that have no color of their own.
 */
export function ChartView({
  document,
  height = 320,
  showTitle = true,
  showSource = true,
  palette,
  className,
}: {
  document: Pick<ChartDocument, "spec" | "data" | "source">;
  height?: number | "fill";
  showTitle?: boolean;
  showSource?: boolean;
  palette?: readonly string[];
  className?: string;
}) {
  const { spec, data, source } = document;
  // Gradient ids are document-wide: two charts on a page must not share them.
  const idPrefix = `c${useId().replace(/[^a-zA-Z0-9]/g, "")}-`;
  const [frameRef, measured] = useWidth<HTMLDivElement>();
  // Ticks are thinned for the real width, so a narrow card never overlaps its labels.
  const width = measured || DEFAULT_WIDTH;
  // Series the person switched off in the legend; their values are blanked, colors stay put.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const toggleable = !isPieType(spec) && spec.series.length > 1;
  const toggle = useCallback(
    (key: string) =>
      setHidden((current) => {
        const next = new Set(current);
        if (next.has(key)) next.delete(key);
        // The last visible series stays: an empty plot says nothing.
        else if (spec.series.length - next.size > 1) next.add(key);
        return next;
      }),
    [spec.series.length],
  );
  const plotted = useMemo(() => {
    const isPie = spec.chart_type === "pie" || spec.chart_type === "donut";
    const hasRight = spec.series.some((s) => s.y_axis === "right");
    // A pie's legend sits beside it when there is room, under it in a narrow card.
    const sideLegend = isPie && width >= SIDE_LEGEND_MIN_WIDTH;
    const rows =
      hidden.size === 0
        ? data
        : data.map((row) => {
            const copy = { ...row };
            for (const key of hidden) copy[key] = null;
            return copy;
          });
    // The tooltip is built before the chart; it reads the chart's own date format once it exists.
    let formatLabel: (value: unknown) => string = String;
    const prepared = prepareChart(spec, rows, {
      width,
      height: 320,
      renderTitle: false,
      idPrefix,
      palette,
      margin: { top: 8, right: hasRight ? 8 : 16, bottom: 4, left: 0 },
      children:
        spec.chart_type === "kpi_card"
          ? undefined
          : [
              <Tooltip
                key="tooltip"
                cursor={isPie ? false : { fill: "var(--muted)", opacity: 0.5 }}
                content={
                  <ChartTooltipContent
                    cn={cn}
                    percent={isPercentStackedChartType(spec.chart_type)}
                    isDualAxis={hasRight}
                    hideTotal={spec.hide_total}
                    hideLabel={isPie}
                    labelFormatter={(value) => formatLabel(value)}
                  />
                }
              />,
              // One series needs no legend: the title names it.
              ...(isPie || spec.series.length > 1
                ? [
                    <Legend
                      key="legend"
                      verticalAlign={sideLegend ? "middle" : "bottom"}
                      align={sideLegend ? "right" : "center"}
                      layout={sideLegend ? "vertical" : "horizontal"}
                      content={
                        <ToggleLegend off={hidden} onSwitch={toggleable ? toggle : undefined} />
                      }
                    />,
                  ]
                : []),
            ],
    });
    formatLabel = prepared.formatLabel;
    const categories = prepared.legend.map((entry) => entry.label);
    return { prepared, categories };
  }, [spec, data, idPrefix, width, hidden, toggle, toggleable, palette]);

  const { prepared, categories } = plotted;
  const config = useMemo(
    () => configFor({ spec, data }, isPieType(spec) ? categories : [], palette),
    [spec, data, categories, palette],
  );
  const caption = sourceCaption(source, spec.x_axis_type === "date");

  return (
    <figure
      className={cn("flex min-h-0 min-w-0 flex-col gap-2", className)}
      data-chart={spec.chart_type}
    >
      {showTitle ? (
        <figcaption className="text-[14px] font-medium text-foreground" dir="auto">
          {spec.title}
        </figcaption>
      ) : null}
      {prepared.isKpi ? (
        <KpiValues document={document} />
      ) : (
        <ChartConfigProvider config={config}>
          <div
            ref={frameRef}
            className="min-h-0 w-full text-[12px] text-muted-foreground"
            style={{ height: height === "fill" ? "100%" : height }}
          >
            <ResponsiveContainer width="100%" height="100%">
              {cloneElement(prepared.chart)}
            </ResponsiveContainer>
          </div>
        </ChartConfigProvider>
      )}
      {showSource ? (
        <p className="truncate text-[12px] text-muted-foreground" dir="auto">
          {caption}
        </p>
      ) : null}
    </figure>
  );
}

/**
 * A KPI's numbers: each series' latest value, large, with its change against the previous row.
 * The series label shows only when there are several (the title already names a single one).
 */
export function KpiValues({
  document,
  size = "md",
}: {
  document: Pick<ChartDocument, "spec" | "data">;
  size?: "md" | "lg";
}) {
  const { spec, data } = document;
  const xAxisKey = resolveDataKey(data, spec.x_axis_key ?? undefined);
  const several = spec.series.length > 1;
  return (
    <div className="flex flex-wrap gap-x-8 gap-y-3">
      {spec.series.map((series) => {
        const key = resolveDataKey(data, series.data_key);
        const value = data.at(-1)?.[key];
        const text =
          typeof value === "number"
            ? formatChartValue(value, series.value_format)
            : String(value ?? "–");
        const change = computeKpiComparison(data, xAxisKey, key, spec.comparison_mode);
        const tone =
          change?.colored && change.direction === "up"
            ? "text-success"
            : change?.colored && change.direction === "down"
              ? "text-destructive"
              : "text-muted-foreground";
        return (
          <div key={series.data_key} className="min-w-0">
            {several ? (
              <p className="truncate text-[12.5px] text-muted-foreground" dir="auto">
                {series.label ?? series.data_key}
              </p>
            ) : null}
            <p
              className={cn(
                "font-semibold tracking-tight text-foreground tabular-nums",
                size === "lg" ? "text-[34px] leading-[1.15]" : "text-[26px] leading-[1.2]",
              )}
            >
              {text}
            </p>
            {change ? (
              <p className={cn("mt-1 flex items-center gap-1 text-[12.5px]", tone)}>
                {change.direction !== "flat" ? (
                  <span aria-hidden>{change.direction === "up" ? "↑" : "↓"}</span>
                ) : null}
                <span className="font-medium tabular-nums">{change.valueText}</span>
                <span className="text-muted-foreground">{t`vs. ${change.periodLabel}`}</span>
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function isPieType(spec: ChartDocument["spec"]) {
  return spec.chart_type === "pie" || spec.chart_type === "donut";
}
