import type { ReplyCardDataOf } from "@aiden/contracts";
import { Button } from "@aiden/ui-web";
import { useLingui } from "@lingui/react/macro";
import { Download, Eye, FileText } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { decodeArtifactBase64, downloadArtifactBytes } from "../../lib/artifact-open";
import { rpc } from "../../lib/rpc";
import { Frame, formatSize } from "./catalog";

// The preview pulls in the PDF and markdown viewers; load them only when a card is opened.
const ArtifactPreviewDialog = lazy(() =>
  import("../../pages/muse/library/ArtifactPreviewDialog").then((m) => ({
    default: m.ArtifactPreviewDialog,
  })),
);

/**
 * A file the Muse saved with `artifact_save`: Open previews it in Nova (the Library's sheet),
 * Download saves the bytes. The same deliverable the Library lists, addressed by artifact id.
 */
export function ArtifactFileCard({
  title,
  data,
}: {
  title?: string;
  data: ReplyCardDataOf<"file">;
}) {
  const { t } = useLingui();
  const artifactId = data.artifactId;
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!artifactId) return null;
  const meta = [
    data.kind?.toUpperCase(),
    data.size !== undefined ? formatSize(data.size) : null,
    data.version && data.version > 1 ? t`Version ${data.version}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  async function download() {
    if (!artifactId) return;
    setFailed(false);
    try {
      const artifact = await rpc.artifacts.getById({ artifactId });
      downloadArtifactBytes(
        artifact.name,
        artifact.mimeType,
        decodeArtifactBase64(artifact.contentBase64),
      );
    } catch {
      setFailed(true);
    }
  }

  return (
    <Frame title={title}>
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground"
        >
          <FileText size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-medium" dir="auto">
            {data.name}
          </div>
          <div className="truncate text-[12.5px] text-muted-foreground">
            {failed ? t`Could not download this.` : meta}
          </div>
        </div>
        <Button
          variant="outline"
          size="icon"
          aria-label={t`Open ${data.name}`}
          onClick={() => setOpen(true)}
        >
          <Eye />
        </Button>
        <Button
          variant="outline"
          size="icon"
          aria-label={t`Download ${data.name}`}
          onClick={() => void download()}
        >
          <Download />
        </Button>
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
