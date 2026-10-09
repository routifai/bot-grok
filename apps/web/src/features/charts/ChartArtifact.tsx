import { useLingui } from "@lingui/react/macro";
import { type ChartDocument, parseChartDocument } from "@nova/charts";
import { BarChart3 } from "lucide-react";
import { useEffect, useState } from "react";
import { decodeArtifactBase64 } from "../../lib/artifact-open";
import { rpc } from "../../lib/rpc";
import { ChartView } from "./ChartView";

/** A request for a chart's document that gets no answer in this long fails, so it can be retried. */
const LOAD_TIMEOUT_MS = 20_000;

const documents = new Map<string, unknown>();
const loading = new Map<string, Promise<unknown>>();

/**
 * Loading an artifact document: "failed" when its bytes are not that kind of document, "error"
 * when the request for them failed (offline, the API restarting): that one can be retried.
 */
export type DocumentState<T> =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "error" }
  | { status: "ready"; doc: T };
export type ChartDocumentState = DocumentState<ChartDocument>;

const cacheKey = (artifactId: string, version: number | undefined) =>
  `${artifactId}:${version ?? ""}`;

/**
 * An artifact's document, fetched once per version and kept for the session; null when the bytes
 * do not parse. Rejects when the request fails or gets no answer, and is fetched again next time.
 */
export function loadArtifactDocument<T>(
  artifactId: string,
  version: number | undefined,
  parse: (bytes: Uint8Array) => T | null,
  bytes?: Uint8Array,
): Promise<T | null> {
  const key = cacheKey(artifactId, version);
  if (documents.has(key)) return Promise.resolve(documents.get(key) as T);
  const inflight = loading.get(key);
  if (inflight) return inflight as Promise<T | null>;
  const raw = bytes
    ? Promise.resolve(bytes)
    : rpc.artifacts
        .getById({ artifactId }, { signal: AbortSignal.timeout(LOAD_TIMEOUT_MS) })
        .then((artifact) => decodeArtifactBase64(artifact.contentBase64));
  const load = raw
    .then((content) => {
      const doc = parse(content);
      if (doc) documents.set(key, doc);
      return doc;
    })
    .finally(() => loading.delete(key));
  loading.set(key, load);
  return load;
}

/** The document already loaded for this version, if any (renders without a loading frame). */
export function cachedArtifactDocument<T>(artifactId: string, version: number | undefined) {
  return documents.get(cacheKey(artifactId, version)) as T | undefined;
}

/** A chart artifact's document; see {@link loadArtifactDocument}. */
export const loadChartDocument = (artifactId: string, version: number | undefined) =>
  loadArtifactDocument(artifactId, version, parseChartDocument);

export const cachedChartDocument = (artifactId: string, version: number | undefined) =>
  cachedArtifactDocument<ChartDocument>(artifactId, version);

/** The state a settled load leaves: ready, unreadable, or a request that failed. */
export function settled<T>(load: Promise<T | null>): Promise<DocumentState<T>> {
  return load.then(
    (doc): DocumentState<T> => (doc ? { status: "ready", doc } : { status: "failed" }),
    (): DocumentState<T> => ({ status: "error" }),
  );
}

/**
 * An artifact's document: from its bytes when the panel has them, else fetched once. `retry`
 * fetches again after a failed request.
 */
export function useArtifactDocument<T>(
  artifactId: string,
  version: number | undefined,
  parse: (bytes: Uint8Array) => T | null,
  bytes?: Uint8Array,
  enabled = true,
): [DocumentState<T>, () => void] {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<DocumentState<T>>(() => {
    const cached = cachedArtifactDocument<T>(artifactId, version);
    return cached ? { status: "ready", doc: cached } : { status: "loading" };
  });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    if (!cachedArtifactDocument(artifactId, version)) setState({ status: "loading" });
    void settled(loadArtifactDocument(artifactId, version, parse, bytes)).then(
      (next) => !cancelled && setState(next),
    );
    return () => {
      cancelled = true;
    };
  }, [artifactId, version, bytes, enabled, parse, attempt]);
  return [state, () => setAttempt((n) => n + 1)];
}

/** A chart artifact's document; see {@link useArtifactDocument}. */
export function useChartDocument(
  artifactId: string,
  version: number | undefined,
  bytes?: Uint8Array,
  enabled = true,
): ChartDocumentState {
  return useArtifactDocument(artifactId, version, parseChartDocument, bytes, enabled)[0];
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
  if (state.status === "failed" || state.status === "error") return <>{fallback}</>;
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
