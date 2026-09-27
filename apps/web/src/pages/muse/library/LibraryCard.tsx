import { Trans, useLingui } from "@lingui/react/macro";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@rakazo/ui-web";
import { Download, Ellipsis } from "lucide-react";
import { formatRelativeTime } from "../../../lib/relative-time";
import { Eyebrow, Surface } from "../ui";
import { ArtifactThumbnail } from "./ArtifactThumbnail";
import { artifactKind, kindEyebrow } from "./kinds";
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

  return (
    <Surface
      interactive
      className="group relative flex flex-col overflow-hidden p-0 hover:border-ring/50"
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex flex-col text-start outline-none"
        data-testid="library-card"
      >
        <div className="aspect-[16/10] w-full bg-muted">
          <ArtifactThumbnail artifact={artifact} />
        </div>
        <div className="flex flex-col gap-1.5 p-4">
          <Eyebrow>{kindEyebrow(kind)}</Eyebrow>
          <h3 className="line-clamp-1 text-[14.5px] font-semibold text-foreground">
            {artifact.name}
          </h3>
          <p className="text-[12px] text-muted-foreground">
            <Trans>Updated {formatRelativeTime(artifact.createdAt)}</Trans>
          </p>
        </div>
      </button>

      <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-end gap-1 p-2 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
        <div className="pointer-events-auto flex items-center gap-1 rounded-full bg-card/95 p-1 shadow-float">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t`Download ${artifact.name}`}
            title={t`Download`}
            onClick={(event) => {
              event.stopPropagation();
              onDownload();
            }}
          >
            <Download size={14} strokeWidth={1.75} />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t`More actions for ${artifact.name}`}
                  onClick={(event) => event.stopPropagation()}
                />
              }
            >
              <Ellipsis size={14} strokeWidth={1.75} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onOpen}>
                <Trans>Open</Trans>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onDownload}>
                <Trans>Download</Trans>
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onClick={onDelete}>
                <Trans>Delete</Trans>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </Surface>
  );
}
