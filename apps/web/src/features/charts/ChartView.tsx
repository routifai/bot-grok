import { t } from "@lingui/core/macro";
import {
  type ChartConfig,
  ChartConfigProvider,
  type ChartDocument,
  ChartLegendContent,
  ChartTooltipContent,
  defaultColorFor,
  isPercentStackedChartType,
  Legend,
  prepareChart,
  ResponsiveContainer,
  Tooltip,
} from "@nova/charts";
import { cn } from "@nova/ui-web";
import { cloneElement, useId, useMemo } from "react";

/** The series' labels, colors and formats, which the tooltip and legend read by column name. */
function configFor(document: Pick<ChartDocument, "spec" | "data">, categories: string[]) {
  const config: ChartConfig = {};
  document.spec.series.forEach((series, index) => {
    config[series.data_key] = {
      label: series.label ?? series.data_key,
      color: series.color ?? defaultColorFor(series.data_key, index),
      isTotal: series.is_total,
      valueFormat: series.value_format,
    };
  });
  categories.forEach((category, index) => {
    config[category] = { label: category, color: defaultColorFor(category, index) };
  });
  return config;
}

/**
 * A saved chart: its title, the interactive chart (hover tooltip, legend) in the Nova tokens, and
 * the source line. `height` is the plot's height in px, or `"fill"` to use the parent's.
 */
export function ChartView({
  document,
  height = 320,
  showTitle = true,
  showSource = true,
  className,
}: {
  document: Pick<ChartDocument, "spec" | "data" | "source">;
  height?: number | "fill";
  showTitle?: boolean;
  showSource?: boolean;
  className?: string;
}) {
  const { spec, data, source } = document;
  // Gradient ids are document-wide: two charts on a page must not share them.
  const idPrefix = `c${useId().replace(/[^a-zA-Z0-9]/g, "")}-`;
  const plotted = useMemo(() => {
    const isPie = spec.chart_type === "pie" || spec.chart_type === "donut";
    const hasRight = spec.series.some((s) => s.y_axis === "right");
    const prepared = prepareChart(spec, data, {
      width: 640,
      height: 320,
      renderTitle: false,
      idPrefix,
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
                  />
                }
              />,
              <Legend
                key="legend"
                verticalAlign={isPie ? "middle" : "bottom"}
                align={isPie ? "right" : "center"}
                layout={isPie ? "vertical" : "horizontal"}
                content={<ChartLegendContent cn={cn} />}
              />,
            ],
    });
    const categories = prepared.legend.map((entry) => entry.label);
    return { prepared, categories };
  }, [spec, data, idPrefix]);

  const { prepared, categories } = plotted;
  const config = useMemo(
    () => configFor({ spec, data }, isPieType(spec) ? categories : []),
    [spec, data, categories],
  );
  const caption = source.truncated
    ? t`Source: ${source.file} (first ${source.rows} rows)`
    : t`Source: ${source.file}`;

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
        <div className="px-1 py-3 text-foreground">{prepared.chart}</div>
      ) : (
        <ChartConfigProvider config={config}>
          <div
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

function isPieType(spec: ChartDocument["spec"]) {
  return spec.chart_type === "pie" || spec.chart_type === "donut";
}
