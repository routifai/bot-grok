import { useLingui } from "@lingui/react/macro";
import type { Artifact } from "@nova/contracts";
import { Button } from "@nova/ui-web";
import { Loader2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useArtifactPanel } from "../../components/cards/context";
import { decodeArtifactBase64, downloadArtifactBytes } from "../../lib/artifact-open";
import { rpc } from "../../lib/rpc";

export type DeckExportFormat = "pptx" | "pdf";
type ExportState =
  | { kind: "idle" }
  | { kind: "working"; format: DeckExportFormat }
  | { kind: "done"; file: Artifact }
  | { kind: "error"; format: DeckExportFormat };

/** Export a deck to a new file in the same chat; one export at a time. */
export function useDeckExport(deckId: string | undefined) {
  const [state, setState] = useState<ExportState>({ kind: "idle" });
  const busy = useRef(false);
  useEffect(() => setState({ kind: "idle" }), [deckId]);

  const run = useCallback(
    async (format: DeckExportFormat) => {
      if (!deckId || busy.current) return;
      busy.current = true;
      setState({ kind: "working", format });
      try {
        const file = await rpc.decks.export({ artifactId: deckId, format });
        setState({ kind: "done", file });
      } catch {
        setState({ kind: "error", format });
      } finally {
        busy.current = false;
      }
    },
    [deckId],
  );
  return { state, run, dismiss: () => setState({ kind: "idle" }) };
}

export function DeckExportButtons({
  state,
  onExport,
}: {
  state: ExportState;
  onExport: (format: DeckExportFormat) => void;
}) {
  const { t } = useLingui();
  const working = state.kind === "working" ? state.format : null;
  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        disabled={working !== null}
        aria-busy={working === "pptx"}
        onClick={() => onExport("pptx")}
      >
        {working === "pptx" ? (
          <Loader2 className="animate-spin motion-reduce:animate-none" />
        ) : null}
        {working === "pptx" ? t`Preparing PowerPoint…` : t`Export to PowerPoint`}
      </Button>
      <Button
        variant="secondary"
        size="sm"
        disabled={working !== null}
        aria-busy={working === "pdf"}
        onClick={() => onExport("pdf")}
      >
        {working === "pdf" ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : null}
        {working === "pdf" ? t`Preparing PDF…` : t`Export to PDF`}
      </Button>
    </>
  );
}

/** The result line under the panel header: working, the new file, or a calm failure. */
export function DeckExportStatus({
  state,
  onDismiss,
  onRetry,
}: {
  state: ExportState;
  onDismiss: () => void;
  onRetry: (format: DeckExportFormat) => void;
}) {
  const { t } = useLingui();
  const panel = useArtifactPanel();
  const [downloading, setDownloading] = useState(false);
  if (state.kind === "idle") return null;

  async function download(file: Artifact) {
    setDownloading(true);
    try {
      const full = await rpc.artifacts.getById({ artifactId: file.id });
      downloadArtifactBytes(full.name, full.mimeType, decodeArtifactBase64(full.contentBase64));
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div
      role="status"
      data-testid="deck-export-status"
      className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2 text-[12.5px]"
    >
      {state.kind === "working" ? (
        <span className="text-muted-foreground">
          {state.format === "pptx"
            ? t`Preparing your PowerPoint. This can take a minute.`
            : t`Preparing your PDF. This can take a minute.`}
        </span>
      ) : state.kind === "done" ? (
        <>
          <span className="min-w-0 flex-1 truncate" dir="auto">
            {t`${state.file.name} is ready`}
          </span>
          <Button
            size="sm"
            variant="secondary"
            disabled={downloading}
            onClick={() => void download(state.file)}
          >
            {t`Download`}
          </Button>
          {panel ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => panel.open(state.file.id, state.file.name)}
            >
              {t`Open`}
            </Button>
          ) : null}
        </>
      ) : (
        <>
          <span className="min-w-0 flex-1 text-muted-foreground">
            {state.format === "pptx"
              ? t`Couldn't prepare the PowerPoint. Nothing was changed.`
              : t`Couldn't prepare the PDF. Nothing was changed.`}
          </span>
          <Button size="sm" variant="secondary" onClick={() => onRetry(state.format)}>
            {t`Try again`}
          </Button>
        </>
      )}
      {state.kind === "working" ? null : (
        <Button variant="ghost" size="icon-sm" aria-label={t`Dismiss`} onClick={onDismiss}>
          <X />
        </Button>
      )}
    </div>
  );
}
