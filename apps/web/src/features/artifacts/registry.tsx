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
  /** True while an overlay should take Escape instead of closing the panel. */
  holdsEscape?: boolean;
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
  usePanel(args: { artifact: Artifact | undefined; title?: string }): ArtifactPanelParts;
  /** Plain function for a Library card. */
  card(artifact: Artifact): ArtifactCardParts | null;
  /** A viewer for this file, or null to leave it to the default preview. */
  view?(props: ArtifactViewProps): ReactNode | null;
}

const ArtifactRegistryContext = createContext<readonly ArtifactExtension[]>([]);
export const ArtifactRegistryProvider = ArtifactRegistryContext.Provider;
export const useArtifactExtensions = () => useContext(ArtifactRegistryContext);

/** Every extension's panel parts, merged in registry order. */
export function useArtifactPanelParts(args: {
  artifact: Artifact | undefined;
  title?: string;
}): Required<ArtifactPanelParts> {
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
    holdsEscape: parts.some((part) => part.holdsEscape),
  };
}

/** Every extension's card parts for one artifact. */
export function useArtifactCardParts(artifact: Artifact): ArtifactCardParts[] {
  return useArtifactExtensions()
    .map((extension) => extension.card(artifact))
    .filter((part): part is ArtifactCardParts => part !== null);
}
