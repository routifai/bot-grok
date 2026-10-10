import { useLingui } from "@lingui/react/macro";
import {
  type ChartDocument,
  type DashboardChart,
  type DashboardDocument,
  parseDashboardDocument,
} from "@nova/charts";
import { Button, cn, Dialog, DialogClose, DialogContent, DialogTitle } from "@nova/ui-web";
import { Maximize2, X } from "lucide-react";
import { useState } from "react";
import { useArtifactPanel } from "../../components/cards/context";
import { useArtifactDocument } from "./ChartArtifact";
import { ChartLoadProblem, FRAME } from "./ChartResult";
import { ChartView, KpiValues, sourceCaption } from "./ChartView";

/**
 * Series colors on a dashboard: the palette's accents, so a set of charts reads at a glance (the
 * app's chrome stays monochrome; a lone chart keeps the ink-first palette).
 */
const ACCENTS = [2, 8, 7, 6, 4].map((n) => `var(--chart-${n})`);

/** A one-series chart takes the next accent, so neighbours differ; several series start over. */
function paletteFor(chart: ChartDocument, index: number): readonly string[] {
  const { chart_type, series } = chart.spec;
  if (series.length > 1 || chart_type === "pie" || chart_type === "donut") return ACCENTS;
  const offset = index % ACCENTS.length;
  return [...ACCENTS.slice(offset), ...ACCENTS.slice(0, offset)];
}

type Size = "card" | "panel";

const PLOT_HEIGHT: Record<Size, { half: number; wide: number }> = {
  card: { half: 280, wide: 280 },
  panel: { half: 320, wide: 340 },
};

function KpiTile({ kpi }: { kpi: ChartDocument }) {
  return (
    <figure
      data-chart="kpi_card"
      title={sourceCaption(kpi.source, false)}
      className="flex min-w-0 flex-col gap-1 rounded-xl bg-secondary px-4 pt-3 pb-3.5"
    >
      <figcaption className="truncate text-[12.5px] text-muted-foreground" dir="auto">
        {kpi.spec.title}
      </figcaption>
      <KpiValues document={kpi} size="lg" />
    </figure>
  );
}

function ChartTile({
  chart,
  index,
  size,
  columns,
}: {
  chart: DashboardChart;
  index: number;
  size: Size;
  columns: boolean;
}) {
  const wide = !!chart.wide || !columns;
  return (
    <section
      className={cn(
        "flex min-w-0 flex-col gap-3 rounded-xl border border-border px-4 pt-3.5 pb-3",
        chart.wide && "@[40rem]:col-span-2",
      )}
    >
      <h4 className="text-[13.5px] leading-5 font-medium text-foreground" dir="auto">
        {chart.spec.title}
      </h4>
      <ChartView
        document={chart}
        height={wide ? PLOT_HEIGHT[size].wide : PLOT_HEIGHT[size].half}
        showTitle={false}
        palette={paletteFor(chart, index)}
      />
    </section>
  );
}

/**
 * A dashboard: its title and sources, the KPI tiles in a row, then the charts in a grid (two per
 * row where there is room, a `wide` chart across the row), every chart interactive.
 */
export function DashboardView({
  document,
  size,
  action,
}: {
  document: DashboardDocument;
  size: Size;
  /** The header's control (Open in the chat). */
  action?: React.ReactNode;
}) {
  const columns = document.layout !== "column";
  return (
    <div
      className="@container flex w-[48rem] min-w-0 max-w-full flex-col gap-4"
      data-testid="dashboard"
    >
      <header className="flex items-start gap-3">
        <h3
          className={cn(
            "min-w-0 flex-1 font-semibold tracking-tight text-foreground",
            size === "panel" ? "text-[22px] leading-8" : "text-[20px] leading-8",
          )}
          dir="auto"
        >
          {document.title}
        </h3>
        {action}
      </header>
      {document.kpis.length ? (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,11rem),1fr))] gap-3">
          {document.kpis.map((kpi, index) => (
            <KpiTile key={`${kpi.spec.title}:${index}`} kpi={kpi} />
          ))}
        </div>
      ) : null}
      <div className={cn("grid gap-3", columns && "@[40rem]:grid-cols-2")}>
        {document.charts.map((chart, index) => (
          <ChartTile
            key={`${chart.spec.title}:${index}`}
            chart={chart}
            index={index}
            size={size}
            columns={columns}
          />
        ))}
      </div>
    </div>
  );
}

/** Opens the dashboard full size: in the artifact panel when the page has one, else a dialog. */
function OpenButton({ artifactId, doc }: { artifactId: string; doc: DashboardDocument }) {
  const { t } = useLingui();
  const panel = useArtifactPanel();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        aria-label={t`Open ${doc.title}`}
        onClick={() => (panel ? panel.open(artifactId, doc.title) : setOpen(true))}
        className="shrink-0 gap-1.5 rounded-lg"
      >
        <Maximize2 />
        {t`Open`}
      </Button>
      {panel ? null : (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent
            showCloseButton={false}
            className="max-h-[92vh] w-[min(1200px,96vw)] overflow-auto rounded-2xl p-6 sm:max-w-none"
          >
            <DialogTitle className="sr-only">{doc.title}</DialogTitle>
            <DashboardView
              document={doc}
              size="panel"
              action={
                <DialogClose
                  aria-label={t`Close dashboard`}
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="-me-1.5 rounded-lg text-muted-foreground"
                    />
                  }
                >
                  <X />
                </DialogClose>
              }
            />
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

/** The frame a dashboard holds while it loads, at about the size it will take. */
function DashboardSkeleton() {
  return (
    <div aria-busy="true" className={cn(FRAME, "flex flex-col gap-4 p-5")}>
      <div className="h-4 w-1/3 animate-pulse rounded bg-muted" />
      <div className="grid grid-cols-3 gap-3">
        {[0, 1, 2].map((n) => (
          <div key={n} className="h-[74px] animate-pulse rounded-xl bg-muted/70" />
        ))}
      </div>
      <div className="h-[300px] animate-pulse rounded-xl bg-muted/50" />
    </div>
  );
}

/** A dashboard the Muse showed (`display_dashboard`), as one card in the chat. */
export function DashboardResult({
  artifactId,
  name,
  version,
}: {
  artifactId: string;
  name: string;
  version?: number;
}) {
  const { t } = useLingui();
  const [state, retry] = useArtifactDocument(artifactId, version, parseDashboardDocument);
  if (state.status === "loading") return <DashboardSkeleton />;
  if (state.status !== "ready") {
    return (
      <ChartLoadProblem
        artifactId={artifactId}
        name={name.replace(/\.dashboard\.json$/i, "")}
        onRetry={state.status === "error" ? retry : undefined}
        unavailable={t`Dashboard unavailable`}
      />
    );
  }
  return (
    <article className={cn(FRAME, "w-full p-5")} data-dashboard={artifactId}>
      <DashboardView
        document={state.doc}
        size="card"
        action={<OpenButton artifactId={artifactId} doc={state.doc} />}
      />
    </article>
  );
}

/** The dashboard in the artifact panel and the Library: full size. */
export function DashboardPanelView({
  artifactId,
  version,
  bytes,
  fallback,
}: {
  artifactId: string;
  version: number;
  bytes: Uint8Array;
  fallback: React.ReactNode;
}) {
  const [state] = useArtifactDocument(artifactId, version, parseDashboardDocument, bytes);
  if (state.status === "failed" || state.status === "error") return <>{fallback}</>;
  if (state.status === "loading") return null;
  return (
    <div className="h-full overflow-auto px-6 pt-5 pb-8">
      <div className="mx-auto max-w-[1200px]">
        <DashboardView document={state.doc} size="panel" />
      </div>
    </div>
  );
}
