import { Trans, useLingui } from "@lingui/react/macro";
import { Button, cn, Dialog, DialogContent, DialogHeader, DialogTitle } from "@nova/ui-web";
import { Download, Lock } from "lucide-react";
import { useState } from "react";
import { downloadArtifactBytes } from "../../../lib/artifact-open";
import { ArtifactPreview } from "../Artifacts";
import { FullScreenToggle } from "../FullScreenToggle";
import { useArtifactPanelParts } from "../registry";
import { useArtifactContent } from "./useArtifactContent";

/**
 * The Library's "open" flow: reuses `Artifacts.tsx`'s `ArtifactPreview` (the same
 * sandboxed HTML viewer, PDF viewer, markdown render and image view it already has)
 * inside a floating dialog instead of the full Artifacts page's split layout.
 */
export function ArtifactPreviewDialog({
  artifactId,
  onOpenChange,
}: {
  artifactId: string;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useLingui();
  const state = useArtifactContent(artifactId);
  const [fullScreen, setFullScreen] = useState(false);
  const ready = state.status === "ready" ? state : null;
  // Same registry parts as ArtifactPanel, so apps/sheets add their controls here too.
  const extra = useArtifactPanelParts({ artifact: ready?.artifact });

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "flex max-w-none flex-col gap-0 overflow-hidden p-0",
          fullScreen
            ? "h-screen w-screen sm:max-w-none sm:rounded-none"
            : "h-[90vh] w-[94vw] sm:max-w-6xl sm:rounded-3xl",
        )}
      >
        <DialogHeader className="shrink-0 flex-row items-center justify-between gap-3 border-b border-border px-5 py-3.5 text-left">
          <DialogTitle className="min-w-0 flex-1 truncate pe-8 text-[15px] font-medium">
            {state.status === "ready" ? state.artifact.name : t`Loading…`}
          </DialogTitle>
          {extra.badge}
          {state.versions.length > 1 ? (
            <select
              aria-label={t`Version`}
              value={state.versionId ?? ""}
              onChange={(event) => state.selectVersion(event.target.value)}
              className="ms-auto rounded-full border border-border bg-card px-3 py-1.5 text-[12.5px] text-foreground outline-none focus:border-ring"
            >
              {state.versions.map((entry, index) => (
                <option key={entry.id} value={entry.id}>
                  {index === 0 ? t`Version ${entry.version} (latest)` : t`Version ${entry.version}`}
                </option>
              ))}
            </select>
          ) : null}
          {ready?.artifact.mimeType === "text/html" ? (
            <FullScreenToggle fullScreen={fullScreen} onToggle={() => setFullScreen((v) => !v)} />
          ) : null}
          {extra.actions}
          {state.status === "ready" ? (
            <Button
              variant="outline"
              size="sm"
              className="me-8"
              onClick={() =>
                downloadArtifactBytes(state.artifact.name, state.artifact.mimeType, state.bytes)
              }
            >
              <Download className="me-1.5" size={14} strokeWidth={1.75} />
              <Trans>Download</Trans>
            </Button>
          ) : null}
        </DialogHeader>
        {extra.below}
        {extra.overlay}

        <div className="relative min-h-0 flex-1">
          {state.status === "loading" ? (
            <div className="grid h-full place-items-center text-[13.5px] text-muted-foreground">
              <Trans>Loading…</Trans>
            </div>
          ) : state.status === "error" ? (
            <div className="grid h-full place-items-center px-6 text-center text-[13.5px] text-destructive">
              {state.message}
            </div>
          ) : (
            <>
              <ArtifactPreview
                artifact={state.artifact}
                bytes={state.bytes}
                onEdited={state.adoptVersion}
              />
              {state.artifact.mimeType === "text/html" ? (
                <div className="pointer-events-none absolute bottom-3 end-3 flex items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1.5 text-[11px] text-white">
                  <Lock size={12} strokeWidth={2} />
                  <span>
                    <Trans>Isolated preview — no access to your account</Trans>
                  </span>
                </div>
              ) : null}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
