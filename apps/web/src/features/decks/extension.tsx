import { t } from "@lingui/core/macro";
import { type Artifact, isDeckArtifactName } from "@nova/contracts";
import { DropdownMenuItem } from "@nova/ui-web";
import { ExternalLink } from "lucide-react";
import type { ArtifactExtension, ArtifactPanelArgs, ArtifactPanelParts } from "../artifacts";
import { useDeckExport } from "./DeckExport";
import { DeckHeaderActions } from "./DeckHeaderActions";
import { DeckViewer } from "./DeckViewer";
import { PptxPreview } from "./PptxPreview";
import { isPptxArtifact } from "./pptx-normalize";

/** The header of a deck: Edit, Present and one Download menu, plus Open in new tab in `⋯`
 * (Publish… joins it from the apps extension). Replaces the panel's default buttons. */
function useDecksPanel({ artifact, bytes, openUrl }: ArtifactPanelArgs): ArtifactPanelParts {
  const deck: Artifact | undefined =
    artifact && isDeckArtifactName(artifact.name) ? artifact : undefined;
  const { state, run, cancel } = useDeckExport(deck?.id);
  // A PowerPoint file keeps the panel's own Download and full-screen buttons; it only needs room.
  if (!deck) return { wide: !!artifact && isPptxArtifact(artifact) };
  return {
    wide: true,
    hideDefaults: true,
    actions: (
      <DeckHeaderActions
        deckKey={deck.name}
        state={state}
        onExport={run}
        onCancel={cancel}
        source={bytes ? { name: deck.name, mimeType: deck.mimeType, bytes } : undefined}
      />
    ),
    overflow: openUrl ? (
      <DropdownMenuItem render={<a href={openUrl} target="_blank" rel="noreferrer noopener" />}>
        <ExternalLink />
        {t`Open in new tab`}
      </DropdownMenuItem>
    ) : null,
  };
}

/** Opens slide decks (HTML files named `*.deck.html`) in the deck viewer, and PowerPoint files
 * (`.pptx`, such as the Muse's native-chart decks) in a read-only preview. */
export const decksExtension: ArtifactExtension = {
  usePanel: useDecksPanel,
  card: (artifact) => (isDeckArtifactName(artifact.name) ? { meta: t`Slide deck` } : null),
  view: ({ artifact, bytes, onEdited, fallback }) => {
    if (isPptxArtifact(artifact)) return <PptxPreview bytes={bytes} fallback={fallback} />;
    if (!isDeckArtifactName(artifact.name)) return null;
    const html = new TextDecoder("utf-8").decode(bytes);
    // Keyed by the file, not the version: a new version keeps the slide, the mode and the
    // selection instead of starting the viewer over.
    return (
      <DeckViewer
        key={artifact.name}
        html={html}
        title={artifact.name}
        artifact={{ id: artifact.id, version: artifact.version }}
        onEdited={onEdited}
      />
    );
  },
};
