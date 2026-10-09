import type { Artifact } from "@nova/contracts";
import { createContext, Fragment, type ReactNode, useContext } from "react";

/**
 * What a capability built on artifacts (apps, sheets) adds to the artifact surfaces without the
 * artifact code importing it: `Shell` fills the registry, `ArtifactPanel` and `LibraryCard` read
 * it. The list is fixed for the life of the app, so calling each `usePanel` is hook-safe.
 */
export interface ArtifactPanelParts {
  /** Beside the title (e.g. a "Published" pill). */
  badge?: ReactNode;
  /** Header buttons, before the download/close buttons. */
  actions?: ReactNode;
  /** A bar under the header. */
  below?: ReactNode;
  /** A dialog over the panel. */
  overlay?: ReactNode;
  /** The panel is wider for this file (a sheet). */
  wide?: boolean;
  /** The panel takes the room it can while this is on (a deck in edit mode); it returns to its
   * usual width when it ends. */
  expanded?: boolean;
  /** True while an overlay should take Escape instead of closing the panel. */
  holdsEscape?: boolean;
  /** `DropdownMenuItem`s for the header's `⋯` menu (shown only when some extension adds one). */
  overflow?: ReactNode;
  /** The extension draws its own Download / Open in new tab / full screen controls, so the
   * panel leaves its defaults out (a deck: one Download menu, Present, `⋯`). */
  hideDefaults?: boolean;
}

/** What `usePanel` is given about the file being shown. */
export interface ArtifactPanelArgs {
  artifact: Artifact | undefined;
  title?: string;
  /** The shown version's bytes, once loaded. */
  bytes?: Uint8Array;
  /** An object URL of the bytes (for "Open in new tab"), once available. */
  openUrl?: string | null;
}

export interface ArtifactCardParts {
  /** Appended to the card's meta line. */
  meta?: string;
  badge?: ReactNode;
}

export interface ArtifactViewProps {
  artifact: Artifact;
  bytes: Uint8Array;
  onEdited?: (artifactId: string) => void;
  toolbarHost?: HTMLElement | null;
  /** What to show when the viewer cannot (e.g. the file is not readable as a table). */
  fallback: ReactNode;
}

export interface ArtifactExtension {
  /** Called as a hook for every panel render; `artifact` is undefined until the file loads. */
  usePanel(args: ArtifactPanelArgs): ArtifactPanelParts;
  /** Plain function for a Library card. */
  card(artifact: Artifact): ArtifactCardParts | null;
  /** A viewer for this file, or null to leave it to the default preview. */
  view?(props: ArtifactViewProps): ReactNode | null;
  /** A live preview for a chat file card's body (a chart), or null to leave it to the default.
   * `near` is true once the card is close to the viewport, so it can fetch lazily. */
  inline?(props: ArtifactInlineArgs): ReactNode | null;
  /** Draws the whole chat result in place of the file card (a chart drawn as a chart), or null
   * to keep the card. */
  result?(props: ArtifactResultArgs): ReactNode | null;
  /** The Library thumbnail for this file, or null to leave it to the default preview. */
  thumbnail?(artifact: ArtifactThumbnailArgs): ReactNode | null;
}

export interface ArtifactInlineArgs {
  artifactId: string;
  name: string;
  version?: number;
  near: boolean;
}

export interface ArtifactResultArgs {
  artifactId: string;
  name: string;
  version?: number;
  /** The reply card's data, for a fallback to the plain card. */
  data: Record<string, unknown>;
}

export interface ArtifactThumbnailArgs {
  id: string;
  name: string;
  mimeType: string;
  version?: number;
}

const ArtifactRegistryContext = createContext<readonly ArtifactExtension[]>([]);
export const ArtifactRegistryProvider = ArtifactRegistryContext.Provider;
export const useArtifactExtensions = () => useContext(ArtifactRegistryContext);

/** Every extension's panel parts, merged in registry order. */
export function useArtifactPanelParts(
  args: ArtifactPanelArgs,
): Required<ArtifactPanelParts> & { hasOverflow: boolean } {
  const extensions = useArtifactExtensions();
  // The registry never changes after Shell mounts it, so the hook order is stable.
  // biome-ignore lint/correctness/useHookAtTopLevel: a fixed list, called in the same order
  const parts = extensions.map((extension) => extension.usePanel(args));
  const slot = (pick: (part: ArtifactPanelParts) => ReactNode) =>
    parts.map((part, index) => <Fragment key={index}>{pick(part)}</Fragment>);
  return {
    badge: slot((part) => part.badge),
    actions: slot((part) => part.actions),
    below: slot((part) => part.below),
    overlay: slot((part) => part.overlay),
    wide: parts.some((part) => part.wide),
    expanded: parts.some((part) => part.expanded),
    holdsEscape: parts.some((part) => part.holdsEscape),
    overflow: slot((part) => part.overflow),
    hasOverflow: parts.some((part) => !!part.overflow),
    hideDefaults: parts.some((part) => part.hideDefaults),
  };
}

/** Every extension's card parts for one artifact. */
export function useArtifactCardParts(artifact: Artifact): ArtifactCardParts[] {
  return useArtifactExtensions()
    .map((extension) => extension.card(artifact))
    .filter((part): part is ArtifactCardParts => part !== null);
}
