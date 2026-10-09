import { t } from "@lingui/core/macro";
import { type Artifact, isDeckArtifactName } from "@nova/contracts";
import type { ArtifactExtension, ArtifactPanelParts } from "../artifacts";
import { DeckExportButtons, DeckExportStatus, useDeckExport } from "./DeckExport";
import { DeckViewer } from "./DeckViewer";

/** The panel header actions of a deck: export to PowerPoint / PDF, and where the result lands. */
function useDecksPanel({ artifact }: { artifact: Artifact | undefined }): ArtifactPanelParts {
  const deck = artifact && isDeckArtifactName(artifact.name) ? artifact : undefined;
  const { state, run, dismiss } = useDeckExport(deck?.id);
  if (!deck) return {};
  return {
    wide: true,
    actions: <DeckExportButtons state={state} onExport={run} />,
    below: <DeckExportStatus state={state} onDismiss={dismiss} onRetry={run} />,
  };
}

/** Opens slide decks (HTML files named `*.deck.html`) in the deck viewer. */
export const decksExtension: ArtifactExtension = {
  usePanel: useDecksPanel,
  card: (artifact) => (isDeckArtifactName(artifact.name) ? { meta: t`Slide deck` } : null),
  view: ({ artifact, bytes }) => {
    if (!isDeckArtifactName(artifact.name)) return null;
    const html = new TextDecoder("utf-8").decode(bytes);
    return <DeckViewer key={artifact.id} html={html} title={artifact.name} />;
  },
};
