import { Button } from "@aiden/ui-web";
import { useLingui } from "@lingui/react/macro";
import { Download, ExternalLink, Lock, X } from "lucide-react";
import { useEffect } from "react";
import { downloadArtifactBytes } from "../lib/artifact-open";
import { useObjectUrl } from "../lib/use-object-url";
import { ArtifactPreview } from "../pages/Artifacts";
import { useArtifactContent } from "../pages/muse/library/useArtifactContent";
import { formatSize } from "./cards/catalog";

const EMPTY_BYTES = new Uint8Array(0);

/**
 * A deliverable at full height, in the conversation's right column (a full-screen sheet below
 * `md`). Defaults to the latest version; the picker switches content in place. Esc closes.
 */
export function ArtifactPanel({
  artifactId,
  title,
  onClose,
}: {
  artifactId: string;
  title?: string;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const state = useArtifactContent(artifactId);
  const ready = state.status === "ready" ? state : null;
  const url = useObjectUrl(ready?.bytes ?? EMPTY_BYTES, ready?.artifact.mimeType ?? "");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const name = ready?.artifact.name ?? "";
  const meta = ready
    ? [(name.split(".").pop() ?? "").toUpperCase(), formatSize(ready.bytes.byteLength)]
        .filter(Boolean)
        .join(" · ")
    : "";

  return (
    <section
      data-testid="artifact-panel"
      aria-label={title || name || t`Artifact`}
      className="fixed inset-0 z-50 flex min-h-0 flex-col overflow-hidden bg-background md:relative md:inset-auto md:z-auto md:w-[min(46vw,640px)] md:shrink-0 md:rounded-[18px] md:border md:border-line md:bg-panel md:backdrop-blur-xl"
    >
      <header className="flex shrink-0 items-center gap-1 border-b border-border px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-medium" dir="auto">
            {title || name || t`Loading…`}
          </div>
          {meta ? <div className="truncate text-[12px] text-muted-foreground">{meta}</div> : null}
        </div>
        {state.versions.length > 1 ? (
          <select
            aria-label={t`Version`}
            value={state.versionId ?? ""}
            onChange={(event) => state.selectVersion(event.target.value)}
            className="rounded-full border border-border bg-card px-2.5 py-1 text-[12px] tabular-nums text-foreground outline-none focus:border-ring"
          >
            {state.versions.map((entry, index) => (
              <option key={entry.id} value={entry.id}>
                {index === 0 ? t`v${entry.version} (latest)` : t`v${entry.version}`}
              </option>
            ))}
          </select>
        ) : null}
        {ready ? (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t`Download`}
              className="text-muted-foreground"
              onClick={() =>
                downloadArtifactBytes(ready.artifact.name, ready.artifact.mimeType, ready.bytes)
              }
            >
              <Download />
            </Button>
            {url ? (
              <a
                href={url}
                target="_blank"
                rel="noreferrer noopener"
                aria-label={t`Open in new tab`}
                className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <ExternalLink size={16} />
              </a>
            ) : null}
          </>
        ) : null}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t`Close`}
          className="text-muted-foreground"
          onClick={onClose}
        >
          <X />
        </Button>
      </header>
      <div className="relative min-h-0 flex-1">
        {state.status === "loading" ? (
          <div className="grid h-full place-items-center text-[13.5px] text-muted-foreground">
            {t`Loading…`}
          </div>
        ) : state.status === "error" ? (
          <div className="grid h-full place-items-center px-6 text-center text-[13.5px] text-destructive">
            {state.message}
          </div>
        ) : (
          <>
            <ArtifactPreview artifact={state.artifact} bytes={state.bytes} />
            {state.artifact.mimeType === "text/html" ? (
              <Lock
                size={12}
                aria-label={t`Isolated preview`}
                className="pointer-events-none absolute bottom-3 end-3 text-muted-foreground"
              />
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
