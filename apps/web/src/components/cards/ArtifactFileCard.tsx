import type { ReplyCardDataOf } from "@aiden/contracts";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@aiden/ui-web";
import { useLingui } from "@lingui/react/macro";
import { Download, ExternalLink, Maximize2, MoreHorizontal } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { decodeArtifactBase64, downloadArtifactBytes } from "../../lib/artifact-open";
import { rpc } from "../../lib/rpc";
import { ArtifactInlinePreview } from "./ArtifactInlinePreview";
import { catalog, Frame, formatSize } from "./catalog";
import { useArtifactPanel, useLatestSavedFile } from "./context";

// The expanded view pulls in the PDF and markdown viewers; load them only when opened.
const ArtifactPreviewDialog = lazy(() =>
  import("../../pages/muse/library/ArtifactPreviewDialog").then((m) => ({
    default: m.ArtifactPreviewDialog,
  })),
);

/**
 * A file the Muse saved with `artifact_save`, shown as a card with a live preview in the
 * conversation. Expand opens the Library's large viewer; Download and Open in new tab sit in the
 * menu. The same deliverable the Library lists, addressed by artifact id; a card without one
 * (an external `url` file) falls back to the plain file card.
 */
export function ArtifactFileCard({
  title,
  data,
}: {
  title?: string;
  data: ReplyCardDataOf<"file">;
}) {
  return data.artifactId ? (
    <SavedFileCard title={title} data={data} />
  ) : (
    <catalog.file title={title} data={data} />
  );
}

function SavedFileCard({ title, data }: { title?: string; data: ReplyCardDataOf<"file"> }) {
  const { t } = useLingui();
  const artifactId = data.artifactId;
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const panel = useArtifactPanel();
  const newest = useLatestSavedFile(data.name);
  if (!artifactId) return null;
  const version = data.version ?? 1;
  const versions = Math.max(data.versions ?? 1, version);
  const superseded = newest !== undefined && newest.version > version ? newest : null;
  const heading = title || data.name;

  function expand() {
    if (!artifactId) return;
    if (panel) panel.open(artifactId, title);
    else setOpen(true);
  }
  const meta = [data.kind?.toUpperCase(), data.size !== undefined ? formatSize(data.size) : null]
    .filter(Boolean)
    .join(" · ");

  async function fetchFile() {
    if (!artifactId) return null;
    setFailed(false);
    try {
      const artifact = await rpc.artifacts.getById({ artifactId });
      return { artifact, bytes: decodeArtifactBase64(artifact.contentBase64) };
    } catch {
      setFailed(true);
      return null;
    }
  }

  async function download() {
    const file = await fetchFile();
    if (file) downloadArtifactBytes(file.artifact.name, file.artifact.mimeType, file.bytes);
  }

  async function openInNewTab() {
    // Opened synchronously so the popup isn't blocked; pointed at the bytes once they arrive.
    const tab = window.open("", "_blank");
    const file = await fetchFile();
    if (!file) {
      tab?.close();
      return;
    }
    const url = URL.createObjectURL(
      new Blob([new Uint8Array(file.bytes)], { type: file.artifact.mimeType }),
    );
    if (tab) tab.location.href = url;
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  return (
    <Frame className="w-[min(42rem,calc(100vw-3rem))]">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={expand}
          className="min-w-0 flex-1 rounded-md text-start outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="truncate text-[14px] font-medium" dir="auto">
            {heading}
          </div>
          <div className="truncate text-[12.5px] text-muted-foreground">
            {failed ? t`Could not download this.` : meta}
          </div>
        </button>
        {superseded ? (
          <button
            type="button"
            data-testid="artifact-updated"
            onClick={() => panel?.open(superseded.artifactId, title)}
            className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[11.5px] tabular-nums text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {t`Updated — v${superseded.version}`}
          </button>
        ) : versions > 1 ? (
          <span
            data-testid="artifact-version"
            className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[11.5px] tabular-nums text-muted-foreground"
          >
            {`v${version}`}
          </span>
        ) : null}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t`Expand ${data.name}`}
          className="text-muted-foreground"
          onClick={expand}
        >
          <Maximize2 />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={t`More actions for ${data.name}`}
            render={<Button variant="ghost" size="icon-sm" className="text-muted-foreground" />}
          >
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto min-w-40">
            <DropdownMenuItem onClick={() => void download()}>
              <Download />
              {t`Download`}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void openInNewTab()}>
              <ExternalLink />
              {t`Open in new tab`}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="mt-3">
        <ArtifactInlinePreview
          artifactId={artifactId}
          name={data.name}
          kind={data.kind}
          size={data.size}
          version={data.version}
        />
      </div>
      {open ? (
        <Suspense fallback={null}>
          <ArtifactPreviewDialog
            artifactId={artifactId}
            onOpenChange={(next) => {
              if (!next) setOpen(false);
            }}
          />
        </Suspense>
      ) : null}
    </Frame>
  );
}
