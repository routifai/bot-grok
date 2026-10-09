import { useLingui } from "@lingui/react/macro";
import type { ChartDocument } from "@nova/charts";
import { isChartArtifactName, type ThreadMessage } from "@nova/contracts";
import { Button, cn, Dialog, DialogClose, DialogContent, DialogTitle } from "@nova/ui-web";
import { BarChart3, Maximize2, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useArtifactPanel } from "../../components/cards/context";
import { type ChartDocumentState, cachedChartDocument, loadChartDocument } from "./ChartArtifact";
import { ChartView, KpiValues, sourceCaption } from "./ChartView";

/** A chart the Muse showed (`display_chart`): the saved `*.chart.json` artifact a message holds. */
export interface ChartRef {
  messageId: string;
  artifactId: string;
  name: string;
  version?: number;
  /** The chart's title as the Muse gave it, when the card carries one. */
  title?: string;
}

/** The chart a message is made of: one `file` reply card naming a `*.chart.json` artifact. */
export function chartOfMessage(message: ThreadMessage): ChartRef | null {
  if (message.role === "user" || message.blocks.length !== 1) return null;
  const block = message.blocks[0];
  if (block?.kind !== "reply_card" || block.card !== "file" || block.pending) return null;
  const { artifactId, name, version } = block.data as {
    artifactId?: unknown;
    name?: unknown;
    version?: unknown;
  };
  if (typeof artifactId !== "string" || !artifactId) return null;
  if (typeof name !== "string" || !isChartArtifactName(name)) return null;
  return {
    messageId: message.id,
    artifactId,
    name,
    version: typeof version === "number" ? version : undefined,
    title: block.title,
  };
}

/** True for a message that is only a chart; the transcript lays runs of them out together. */
export const isChartMessage = (message: ThreadMessage) => chartOfMessage(message) !== null;

/** Plot height of a chart alone in the column, and of one in a two-column grid. */
const SINGLE_HEIGHT = 300;
const GRID_HEIGHT = 260;
const EXPANDED_HEIGHT = 460;

const FRAME = "min-w-0 rounded-2xl border border-border bg-card text-card-foreground";

/** The documents of several charts, loaded together so the set lays out once, not chart by chart. */
function useChartDocuments(charts: readonly ChartRef[]): ChartDocumentState[] {
  const key = charts.map((chart) => `${chart.artifactId}:${chart.version ?? ""}`).join(",");
  const initial = () =>
    charts.map((chart): ChartDocumentState => {
      const doc = cachedChartDocument(chart.artifactId, chart.version);
      return doc ? { status: "ready", doc } : { status: "loading" };
    });
  const [states, setStates] = useState<ChartDocumentState[]>(initial);
  useEffect(() => {
    let cancelled = false;
    setStates(initial());
    void Promise.all(
      charts.map((chart) =>
        loadChartDocument(chart.artifactId, chart.version).then(
          (doc): ChartDocumentState => (doc ? { status: "ready", doc } : { status: "failed" }),
          (): ChartDocumentState => ({ status: "failed" }),
        ),
      ),
    ).then((next) => !cancelled && setStates(next));
    return () => {
      cancelled = true;
    };
  }, [key]);
  return states;
}

/** Opens a chart large: in the artifact panel when the page has one, else in a dialog. */
function ExpandButton({ chart, doc }: { chart: ChartRef; doc: ChartDocument }) {
  const { t } = useLingui();
  const panel = useArtifactPanel();
  const [open, setOpen] = useState(false);
  const title = doc.spec.title;
  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t`Expand ${title}`}
        title={t`Expand`}
        onClick={() => (panel ? panel.open(chart.artifactId, title) : setOpen(true))}
        className="-me-1.5 -mt-1 shrink-0 rounded-lg text-muted-foreground opacity-0 transition-opacity group-hover/chart:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
      >
        <Maximize2 />
      </Button>
      {panel ? null : (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent
            showCloseButton={false}
            className="flex w-[min(960px,94vw)] flex-col gap-4 rounded-2xl p-6 sm:max-w-none"
          >
            <div className="flex items-start gap-3">
              <DialogTitle className="min-w-0 flex-1 text-[15px] font-medium" dir="auto">
                {title}
              </DialogTitle>
              <DialogClose
                aria-label={t`Close chart`}
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="-me-1.5 -mt-1 rounded-lg text-muted-foreground"
                  />
                }
              >
                <X />
              </DialogClose>
            </div>
            <ChartView document={doc} height={EXPANDED_HEIGHT} showTitle={false} />
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

function Header({
  chart,
  doc,
  children,
}: {
  chart: ChartRef;
  doc: ChartDocument;
  children?: ReactNode;
}) {
  return (
    <header className="flex items-start gap-2">
      <h3 className="min-w-0 flex-1 text-[13.5px] leading-5 font-medium text-foreground" dir="auto">
        {doc.spec.title}
      </h3>
      {children}
      <ExpandButton chart={chart} doc={doc} />
    </header>
  );
}

/** A KPI chart as a number tile: the title, the latest value large, its change, the source. */
function KpiTile({ chart, doc }: { chart: ChartRef; doc: ChartDocument }) {
  return (
    <figure
      data-message-id={chart.messageId}
      data-chart="kpi_card"
      className={cn(FRAME, "group/chart flex flex-col gap-1.5 px-4 pt-3.5 pb-3")}
    >
      <Header chart={chart} doc={doc} />
      <KpiValues document={doc} />
      <figcaption className="mt-auto truncate pt-1 text-[11.5px] text-muted-foreground" dir="auto">
        {sourceCaption(doc.source, doc.spec.x_axis_type === "date")}
      </figcaption>
    </figure>
  );
}

/** A chart card in the transcript: title, the interactive chart, the source line. */
function ChartCard({
  chart,
  doc,
  height,
  className,
}: {
  chart: ChartRef;
  doc: ChartDocument;
  height: number;
  className?: string;
}) {
  return (
    <div
      data-message-id={chart.messageId}
      className={cn(FRAME, "group/chart flex flex-col gap-3 px-4 pt-3.5 pb-3", className)}
    >
      <Header chart={chart} doc={doc} />
      <ChartView document={doc} height={height} showTitle={false} />
    </div>
  );
}

/** The frame a chart holds while its document loads, at the size it will take. */
function ChartSkeleton({ chart, height }: { chart: ChartRef; height: number }) {
  return (
    <div
      data-message-id={chart.messageId}
      aria-busy="true"
      className={cn(FRAME, "flex flex-col gap-3 px-4 pt-4 pb-3")}
    >
      <div className="h-3.5 w-2/5 animate-pulse rounded bg-muted" />
      <div className="animate-pulse rounded-lg bg-muted/60" style={{ height }} />
      <div className="h-3 w-1/4 animate-pulse rounded bg-muted" />
    </div>
  );
}

/** A chart whose file is not a chart document: its name, and Open for the panel's own view. */
function UnreadableChart({ chart }: { chart: ChartRef }) {
  const { t } = useLingui();
  const panel = useArtifactPanel();
  const name = chart.title ?? chart.name.replace(/\.chart\.json$/i, "");
  return (
    <div
      data-message-id={chart.messageId}
      className={cn(FRAME, "flex items-center gap-3 px-4 py-3 text-[13.5px]")}
    >
      <BarChart3
        size={18}
        strokeWidth={1.6}
        className="shrink-0 text-muted-foreground"
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate" dir="auto">
        {name}
      </span>
      <span className="text-muted-foreground">{t`Chart unavailable`}</span>
      {panel ? (
        <Button variant="outline" size="sm" onClick={() => panel.open(chart.artifactId)}>
          {t`Open`}
        </Button>
      ) : null}
    </div>
  );
}

type Item = { chart: ChartRef; state: ChartDocumentState };
type Segment = { kind: "kpis" | "charts" | "files"; items: Item[] };

const isKpi = (item: Item) =>
  item.state.status === "ready" && item.state.doc.spec.chart_type === "kpi_card";

/** Consecutive KPIs form one row, consecutive charts one grid, in the order the Muse showed them. */
function segmentsOf(items: Item[]): Segment[] {
  const segments: Segment[] = [];
  for (const item of items) {
    const kind = item.state.status === "failed" ? "files" : isKpi(item) ? "kpis" : "charts";
    const last = segments.at(-1);
    if (last?.kind === kind) last.items.push(item);
    else segments.push({ kind, items: [item] });
  }
  return segments;
}

/**
 * The charts of consecutive `display_chart` calls, laid out as one set across the message column:
 * KPI tiles in a row, then the charts, two per row when there are several and the column is wide
 * enough (an odd last chart takes the whole row). A chart whose file cannot be read stays the
 * plain file card.
 */
export function ChartGallery({ messages }: { messages: readonly ThreadMessage[] }) {
  return <ChartSet charts={messages.flatMap((message) => chartOfMessage(message) ?? [])} />;
}

function ChartSet({ charts }: { charts: readonly ChartRef[] }) {
  const states = useChartDocuments(charts);
  const items = charts.map((chart, index) => ({
    chart,
    state: states[index] ?? ({ status: "loading" } as const),
  }));
  const several = items.length > 1;

  if (items.some((item) => item.state.status === "loading")) {
    return (
      <div className="@container w-full" data-testid="chart-gallery" aria-busy="true">
        <div className={cn("grid gap-3", several && "@[34rem]:grid-cols-2")}>
          {items.map((item) => (
            <ChartSkeleton
              key={item.chart.messageId}
              chart={item.chart}
              height={several ? GRID_HEIGHT : SINGLE_HEIGHT}
            />
          ))}
        </div>
      </div>
    );
  }

  const nonKpis = items.filter((item) => !isKpi(item) && item.state.status === "ready").length;
  return (
    <div className="@container flex w-full flex-col gap-3" data-testid="chart-gallery">
      {segmentsOf(items).map((segment) => {
        const first = segment.items[0]?.chart.messageId;
        if (segment.kind === "files") {
          return segment.items.map(({ chart }) => (
            <UnreadableChart key={chart.messageId} chart={chart} />
          ));
        }
        if (segment.kind === "kpis") {
          return (
            <div
              key={first}
              className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,13rem),1fr))] gap-3"
            >
              {segment.items.map(({ chart, state }) =>
                state.status === "ready" ? (
                  <KpiTile key={chart.messageId} chart={chart} doc={state.doc} />
                ) : null,
              )}
            </div>
          );
        }
        const pair = segment.items.length > 1;
        return (
          <div key={first} className={cn("grid gap-3", pair && "@[34rem]:grid-cols-2")}>
            {segment.items.map(({ chart, state }, index) =>
              state.status === "ready" ? (
                <ChartCard
                  key={chart.messageId}
                  chart={chart}
                  doc={state.doc}
                  height={nonKpis > 1 ? GRID_HEIGHT : SINGLE_HEIGHT}
                  className={
                    pair && index === segment.items.length - 1 && segment.items.length % 2 === 1
                      ? "@[34rem]:col-span-2"
                      : undefined
                  }
                />
              ) : null,
            )}
          </div>
        );
      })}
    </div>
  );
}

/** One chart file outside a transcript run (a reply card elsewhere): the same card, full width. */
export function ChartResult({
  artifactId,
  name,
  version,
}: {
  artifactId: string;
  name: string;
  version?: number;
}) {
  const charts = [{ messageId: `chart:${artifactId}:${version ?? ""}`, artifactId, name, version }];
  return <ChartSet charts={charts} />;
}
