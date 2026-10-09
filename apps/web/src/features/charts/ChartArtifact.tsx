import { useLingui } from "@lingui/react/macro";
import { type ChartDocument, parseChartDocument } from "@nova/charts";
import { BarChart3 } from "lucide-react";
import { useEffect, useState } from "react";
import { decodeArtifactBase64 } from "../../lib/artifact-open";
import { rpc } from "../../lib/rpc";
import { ChartView } from "./ChartView";

const documents = new Map<string, ChartDocument>();

type State = { status: "loading" } | { status: "failed" } | { status: "ready"; doc: ChartDocument };

/** A chart artifact's document: from its bytes when the panel has them, else fetched once. */
export function useChartDocument(
  artifactId: string,
  version: number | undefined,
  bytes?: Uint8Array,
  enabled = true,
): State {
  const key = `${artifactId}:${version ?? ""}`;
  const [state, setState] = useState<State>(() => {
    const cached = documents.get(key);
    return cached ? { status: "ready", doc: cached } : { status: "loading" };
  });
  useEffect(() => {
    if (!enabled) return;
    const cached = documents.get(key);
    if (cached) return setState({ status: "ready", doc: cached });
    let cancelled = false;
    const load = bytes
      ? Promise.resolve(bytes)
      : rpc.artifacts
          .getById({ artifactId })
          .then((artifact) => decodeArtifactBase64(artifact.contentBase64));
    load
      .then((raw) => {
        if (cancelled) return;
        const doc = parseChartDocument(raw);
        if (!doc) return setState({ status: "failed" });
        documents.set(key, doc);
        setState({ status: "ready", doc });
      })
      .catch(() => !cancelled && setState({ status: "failed" }));
    return () => {
      cancelled = true;
    };
  }, [artifactId, bytes, enabled, key]);
  return state;
}

/** The chart in the artifact panel: the whole chart, full width. */
export function ChartPanelView({
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
  const state = useChartDocument(artifactId, version, bytes);
  if (state.status === "failed") return <>{fallback}</>;
  if (state.status === "loading") return null;
  return (
    <div className="h-full overflow-auto p-5">
      <ChartView document={state.doc} height={420} className="mx-auto max-w-[880px]" />
    </div>
  );
}

/** The chart inside a chat file card: live, quiet, no title (the card carries it). */
export function ChartInlinePreview({
  artifactId,
  version,
  enabled,
}: {
  artifactId: string;
  version?: number;
  enabled: boolean;
}) {
  const { t } = useLingui();
  const state = useChartDocument(artifactId, version, undefined, enabled);
  if (state.status !== "ready") {
    return (
      <div
        className={`grid h-full place-items-center text-muted-foreground ${state.status === "loading" ? "animate-pulse" : ""}`}
        role="img"
        aria-label={t`Chart`}
      >
        <BarChart3 size={28} strokeWidth={1.4} aria-hidden />
      </div>
    );
  }
  return (
    <div className="h-full bg-background px-3 pt-3 pb-1">
      <ChartView document={state.doc} height="fill" showSource={false} className="h-full" />
    </div>
  );
}
