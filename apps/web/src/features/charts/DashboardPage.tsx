import { useLingui } from "@lingui/react/macro";
import { Button, cn, Dialog, DialogContent, DialogTitle } from "@nova/ui-web";
import { Maximize2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useArtifactPanel } from "../../components/cards/context";
import { SandboxedHtmlViewer } from "../../components/SandboxedHtmlViewer";
import { useArtifactDocument } from "./ChartArtifact";
import { ChartLoadProblem, FRAME } from "./ChartResult";
import { useAppTheme } from "./ChartThumbnail";

/** Until the page reports its height; about one KPI row and two rows of charts at chat width. */
const INITIAL_HEIGHT = 640;
/** A taller page scrolls inside the card; Open shows it whole. */
const MAX_HEIGHT = 1600;

const parseHtml = (bytes: Uint8Array) => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
};

/**
 * A dashboard page (`*.dashboard.html`, built by nova-dashboard) in the chat: the live page at the
 * message's full width, sandboxed, as tall as it reports itself, with Open for the full view.
 */
export function DashboardPageResult({
  artifactId,
  name,
  version,
}: {
  artifactId: string;
  name: string;
  version?: number;
}) {
  const { t } = useLingui();
  const panel = useArtifactPanel();
  const [state, retry] = useArtifactDocument(artifactId, version, parseHtml);
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(INITIAL_HEIGHT);
  const [dialog, setDialog] = useState(false);
  // The page follows the app's theme, not the system's (the page reads `data-theme` first).
  const theme = useAppTheme();
  const html = useMemo(
    () =>
      state.status === "ready"
        ? `<script>document.documentElement.dataset.theme=${JSON.stringify(theme)}</script>${state.doc}`
        : "",
    [state, theme],
  );

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      const data = event.data as { type?: unknown; height?: unknown } | null;
      if (data?.type !== "nova:dashboard-height" || typeof data.height !== "number") return;
      if (!Number.isFinite(data.height) || data.height <= 0) return;
      setHeight(Math.min(Math.ceil(data.height), MAX_HEIGHT));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const title = name.replace(/\.dashboard\.html$/i, "");
  if (state.status === "failed" || state.status === "error") {
    return (
      <ChartLoadProblem
        artifactId={artifactId}
        name={title}
        onRetry={state.status === "error" ? retry : undefined}
        unavailable={t`Dashboard unavailable`}
      />
    );
  }
  return (
    // A preferred width capped by the column: inside the w-fit message bubble an iframe has no
    // intrinsic width and would collapse.
    <article
      className={cn(FRAME, "group relative w-[48rem] max-w-full overflow-hidden")}
      data-dashboard-page={artifactId}
    >
      {state.status === "ready" ? (
        <div
          style={{ height }}
          className="transition-[height] duration-200 motion-reduce:transition-none"
        >
          <SandboxedHtmlViewer html={html} title={title} relay frameRef={frame} />
        </div>
      ) : (
        <div aria-busy="true" style={{ height }} className="animate-pulse bg-muted/50" />
      )}
      <div className="absolute end-2.5 top-2.5">
        <Button
          variant="outline"
          size="sm"
          onClick={() => (panel ? panel.open(artifactId) : setDialog(true))}
          aria-label={t`Open ${title}`}
          className="gap-1.5 rounded-lg bg-card/90 backdrop-blur"
        >
          <Maximize2 />
          {t`Open`}
        </Button>
      </div>
      {panel ? null : (
        <Dialog open={dialog} onOpenChange={setDialog}>
          <DialogContent className="h-[90vh] w-[min(1280px,96vw)] overflow-hidden rounded-2xl p-0 sm:max-w-none">
            <DialogTitle className="sr-only">{title}</DialogTitle>
            {dialog && html ? <SandboxedHtmlViewer html={html} title={title} /> : null}
          </DialogContent>
        </Dialog>
      )}
    </article>
  );
}
