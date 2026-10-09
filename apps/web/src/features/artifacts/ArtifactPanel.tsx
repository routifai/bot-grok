import { useLingui } from "@lingui/react/macro";
import { Button, cn } from "@nova/ui-web";
import { Download, ExternalLink, Lock, X } from "lucide-react";
import { useEffect, useState } from "react";
import { formatSize } from "../../components/cards/catalog";
import { downloadArtifactBytes } from "../../lib/artifact-open";
import { useObjectUrl } from "../../lib/use-object-url";
import { ArtifactPreview } from "./Artifacts";
import { FullScreenToggle } from "./FullScreenToggle";
import { useArtifactContent } from "./library/useArtifactContent";
import { PanelOverflowMenu } from "./PanelOverflowMenu";
import { useArtifactPanelParts } from "./registry";

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

  const [toolbarHost, setToolbarHost] = useState<HTMLElement | null>(null);
  const [fullScreen, setFullScreen] = useState(false);
  const isApp = ready?.artifact.mimeType === "text/html";
  const extra = useArtifactPanelParts({
    artifact: ready?.artifact,
    title,
    bytes: ready?.bytes,
    openUrl: url,
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || extra.holdsEscape) return;
      if (fullScreen) setFullScreen(false);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, fullScreen, extra.holdsEscape]);

  const name = ready?.artifact.name ?? "";
  const shown = ready ? state.versions.find((entry) => entry.id === ready.artifact.id) : undefined;
  const meta = ready
    ? [
        (name.split(".").pop() ?? "").toUpperCase(),
        formatSize(ready.bytes.byteLength),
        state.versions.length > 1 && shown ? `v${shown.version}` : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  return (
    <section
      data-testid="artifact-panel"
      aria-label={title || name || t`Artifact`}
      className={cn(
        "fixed inset-0 z-50 flex min-h-0 flex-col overflow-hidden bg-background",
        !fullScreen &&
          "md:relative md:inset-auto md:z-auto md:m-2 md:shrink-0 md:rounded-[18px] md:bg-glass md:ring-[0.5px] md:ring-glass-line md:ring-inset md:backdrop-blur-[30px] md:backdrop-saturate-[1.8]",
        !fullScreen && (extra.wide ? "md:w-[min(58vw,900px)]" : "md:w-[min(46vw,640px)]"),
      )}
    >
      <header className="flex shrink-0 items-center gap-1 border-b border-border px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <div className="truncate text-[14px] font-medium" dir="auto">
              {title || name || t`Loading…`}
            </div>
            {extra.badge}
          </div>
          {meta || state.arrived || state.newer ? (
            <div className="flex min-w-0 items-center gap-2 text-[12px] text-muted-foreground">
              <span className="truncate">{meta}</span>
              {state.arrived ? (
                <span data-testid="artifact-arrived" className="shrink-0 text-foreground">
                  {state.arrived.origin === "manual"
                    ? t`Updated by you · v${state.arrived.version}`
                    : t`Updated by Nova · v${state.arrived.version}`}
                </span>
              ) : null}
              {state.newer ? (
                <button
                  type="button"
                  data-testid="artifact-newer"
                  onClick={state.showNewest}
                  className="shrink-0 rounded-full bg-accent px-2 py-0.5 text-foreground hover:bg-accent/70"
                >
                  {t`Newer version available, show it`}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        {/* A sheet portals its Edit button and edited pill in here. */}
        <div ref={setToolbarHost} className="contents" />
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
        {isApp && !extra.hideDefaults ? (
          <FullScreenToggle fullScreen={fullScreen} onToggle={() => setFullScreen((v) => !v)} />
        ) : null}
        {extra.actions}
        {extra.hasOverflow ? <PanelOverflowMenu>{extra.overflow}</PanelOverflowMenu> : null}
        {ready && !extra.hideDefaults ? (
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
      {extra.below}
      {extra.overlay}
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
            <ArtifactPreview
              artifact={state.artifact}
              bytes={state.bytes}
              onEdited={state.adoptVersion}
              toolbarHost={toolbarHost}
            />
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
