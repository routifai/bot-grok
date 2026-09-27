import { isAttachmentImageMimeType } from "@aiden/contracts";
import { t } from "@lingui/core/macro";
import type { LucideIcon } from "lucide-react";
import { File, FileText, Image as ImageIcon, LayoutTemplate, Presentation } from "lucide-react";

/** How the Library groups and labels an artifact, derived from its mime type. */
export type ArtifactKind = "page" | "document" | "deck" | "image" | "file";

const DECK_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-powerpoint",
  "application/vnd.google-apps.presentation",
  "application/vnd.apple.keynote",
]);

export function artifactKind(mimeType: string): ArtifactKind {
  if (mimeType === "text/html") return "page";
  if (mimeType === "application/pdf") return "document";
  if (DECK_MIME_TYPES.has(mimeType)) return "deck";
  if (isAttachmentImageMimeType(mimeType)) return "image";
  return "file";
}

/** Facet chip order; `LibraryScreen` only shows the ones with at least one artifact. */
export const KIND_ORDER: ArtifactKind[] = ["page", "document", "deck", "image", "file"];

export const KIND_ICON: Record<ArtifactKind, LucideIcon> = {
  page: LayoutTemplate,
  document: FileText,
  deck: Presentation,
  image: ImageIcon,
  file: File,
};

/** The mono type eyebrow shown on each card. */
export function kindEyebrow(kind: ArtifactKind): string {
  if (kind === "document") return "PDF";
  return kind.toUpperCase();
}

/** The plural facet chip label. */
export function kindFacetLabel(kind: ArtifactKind): string {
  switch (kind) {
    case "page":
      return t`Pages`;
    case "document":
      return t`Documents`;
    case "deck":
      return t`Decks`;
    case "image":
      return t`Images`;
    case "file":
      return t`Files`;
    default:
      return kind;
  }
}
