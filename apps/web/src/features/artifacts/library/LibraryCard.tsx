import { Trans, useLingui } from "@lingui/react/macro";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@nova/ui-web";
import { Download, Ellipsis, Maximize2 } from "lucide-react";
import { Fragment } from "react";
import { artifactKind, kindLabel } from "../../../lib/artifact-kind";
import { formatRelativeTime } from "../../../lib/relative-time";
import { ArtifactPreviewCard, GlassAction, glassActionClassName } from "../ArtifactPreviewCard";
import { useArtifactCardParts } from "../registry";
import { LibraryArt } from "./LibraryArt";
import type { ArtifactSummary } from "./types";

export function LibraryCard({
  artifact,
  onOpen,
  onDownload,
  onDelete,
}: {
  artifact: ArtifactSummary;
  onOpen: () => void;
  onDownload: () => void;
  onDelete: () => void;
}) {
  const { t } = useLingui();
  const kind = artifactKind(artifact.mimeType);
  const extra = useArtifactCardParts(artifact);
  const badges = extra.filter((part) => part.badge);
  const meta = [
    `${kindLabel(kind)} · ${formatRelativeTime(artifact.createdAt)}`,
    ...extra.map((part) => part.meta),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <ArtifactPreviewCard
      size="grid"
      artifact={artifact}
      title={artifact.name}
      meta={meta}
      badge={
        badges.length
          ? badges.map((part, index) => <Fragment key={index}>{part.badge}</Fragment>)
          : null
      }
      buttonLabel={t`Open ${artifact.name}`}
      onOpen={onOpen}
      testId="library-card"
      fallback={<LibraryArt kind={kind} name={artifact.name} />}
      actions={
        <>
          <GlassAction label={t`Open ${artifact.name}`} onClick={onOpen}>
            <Maximize2 size={13} strokeWidth={1.9} />
          </GlassAction>
          <GlassAction label={t`Download ${artifact.name}`} onClick={onDownload}>
            <Download size={13} strokeWidth={1.9} />
          </GlassAction>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  aria-label={t`More actions for ${artifact.name}`}
                  onClick={(event) => event.stopPropagation()}
                  className={glassActionClassName}
                />
              }
            >
              <Ellipsis size={13} strokeWidth={1.9} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem variant="destructive" onClick={onDelete}>
                <Trans>Delete</Trans>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      }
    />
  );
}
