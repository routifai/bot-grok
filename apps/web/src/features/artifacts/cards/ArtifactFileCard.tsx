import { useLingui } from "@lingui/react/macro";
import type { ReplyCardDataOf } from "@nova/contracts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@nova/ui-web";
import { Download, ExternalLink, MoreHorizontal } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { catalog, formatSize } from "../../../components/cards/catalog";
import { useArtifactPanel, useLatestSavedFile } from "../../../components/cards/context";
import { MEDIA_ACTION, MediaFrame, MediaTile } from "../../../components/MediaTile";
import type { ArtifactKind } from "../../../lib/artifact-kind";
import { decodeArtifactBase64, downloadArtifactBytes } from "../../../lib/artifact-open";
import { rpc } from "../../../lib/rpc";
import { readableFileName } from "../ArtifactFileCard";
import { ArtifactInlinePreview } from "./ArtifactInlinePreview";

// The expanded view pulls in the PDF and markdown viewers; load them only when opened.
const ArtifactPreviewDialog = lazy(() =>
  import("../library/ArtifactPreviewDialog").then((m) => ({
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
  // Without a title from Nova, the card reads the document's own heading once it loads.
  const [documentTitle, setDocumentTitle] = useState<string | null>(null);
  const panel = useArtifactPanel();
  const newest = useLatestSavedFile(data.name);
  if (!artifactId) return null;
  const version = data.version ?? 1;
  const versions = Math.max(data.versions ?? 1, version);
  const superseded = newest !== undefined && newest.version > version ? newest : null;
  const heading = title || documentTitle || readableFileName(data.name);

  function expand() {
    if (!artifactId) return;
    if (panel) panel.open(artifactId, title);
    else setOpen(true);
  }
  const meta = [
    data.kind?.toUpperCase(),
    data.size !== undefined ? formatSize(data.size) : null,
    data.byYou ? t`Exported by you` : null,
  ]
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

  // The result tile (docs/muse/DESIGN.md "Results"): the live preview framed on the right,
  // Open as the white pill, Download and Open in new tab in the menu.
  const tileKind = data.kind ? kindFromLabel(data.kind) : "file";
  return (
    <div>
      <MediaTile
        kind={tileKind}
        brand={tileKind === "document" ? t`Nova Report` : (data.kind?.toUpperCase() ?? t`File`)}
        title={heading}
        badge={
          superseded ? (
            <button
              type="button"
              data-testid="artifact-updated"
              onClick={() => panel?.open(superseded.artifactId, title)}
              className="ms-1.5 rounded-full bg-white/15 px-2 py-0.5 text-[11.5px] font-normal tabular-nums text-white hover:bg-white/25"
            >
              {t`Updated — v${superseded.version}`}
            </button>
          ) : versions > 1 ? (
            <span
              data-testid="artifact-version"
              className="ms-1.5 rounded-full bg-white/15 px-2 py-0.5 text-[11.5px] font-normal tabular-nums text-white"
            >
              {`v${version}`}
            </span>
          ) : undefined
        }
        art={
          <MediaFrame>
            <ArtifactInlinePreview
              artifactId={artifactId}
              name={data.name}
              kind={data.kind}
              size={data.size}
              version={data.version}
              onHeading={setDocumentTitle}
              className="h-full rounded-none border-0 sm:h-full"
            />
          </MediaFrame>
        }
        meta={failed ? t`Could not download this.` : meta}
        openLabel={t`Open`}
        openAriaLabel={t`Expand ${data.name}`}
        onOpen={expand}
        actions={
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={t`More actions for ${data.name}`}
              className={MEDIA_ACTION}
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
        }
      />
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
    </div>
  );
}

/** A reply card's `kind` label ("pdf", "html", "pptx", "png"…) as an artifact kind. */
function kindFromLabel(label: string): ArtifactKind {
  const value = label.toLowerCase();
  if (value === "pdf" || value === "md" || value === "markdown" || value === "docx")
    return "document";
  if (value === "html" || value === "page") return "page";
  if (value === "pptx" || value === "ppt" || value === "key" || value === "deck") return "deck";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "image"].includes(value)) return "image";
  return "file";
}
