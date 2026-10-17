import { useLingui } from "@lingui/react/macro";
import { Button, cn } from "@superchat/ui-web";
import { ChevronLeft } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { AskDraft } from "./ask/AskBox";
import { ArtifactEditor } from "./editor/ArtifactEditor";
import { artifactKey, useArtifactEditing } from "./editor/editor-state";
import { useArtifactContent } from "./library/useArtifactContent";
import { artifactPanelLayout, useParentWidth } from "./panel-layout";
import { useArtifactEditorKind, useArtifactPanelParts } from "./registry";
import { ArtifactStudio } from "./studio/ArtifactStudio";

/** The artifact on screen in the panel: which file, under which name, at which version. */
export type ShownArtifact = { artifactId: string; name: string; version: number };

/** The panel's width from `md` up before its row is measured: usual, wider for a file that needs
 * room, widest while a file is being edited. Once measured, `artifactPanelLayout` decides. */
export const artifactPanelWidth = ({ wide, expanded }: { wide?: boolean; expanded?: boolean }) =>
  expanded ? "md:w-[min(84vw,1600px)]" : wide ? "md:w-[min(58vw,900px)]" : "md:w-[min(46vw,640px)]";

/**
 * A deliverable at full height in the conversation's right column, in the artifact editor; a
 * sheet over the Conversation when the row is too narrow for both (and full screen below `md`).
 * Defaults to the latest version; the version menu switches content in place. Esc closes.
 */
export function ArtifactPanel({
  artifactId,
  title,
  page,
  opener,
  onClose,
  onShown,
}: {
  artifactId: string;
  title?: string;
  /** Open a PDF at this page (a citation chip). */
  page?: number;
  /** What opened the panel (a file card's Open): the file's studio hands focus back to it. */
  opener?: HTMLElement | null;
  onClose: () => void;
  /** The version on screen once it has loaded, and `null` when the panel goes. */
  onShown?: (shown: ShownArtifact | null) => void;
}) {
  const { t } = useLingui();
  const state = useArtifactContent(artifactId);
  const ready = state.status === "ready" ? state : null;
  const shownId = ready?.artifact.id;
  const shownName = ready?.artifact.name;
  const shownVersion = ready?.artifact.version;
  useEffect(() => {
    if (!onShown || !shownId || shownName === undefined || shownVersion === undefined) return;
    onShown({ artifactId: shownId, name: shownName, version: shownVersion });
  }, [onShown, shownId, shownName, shownVersion]);
  useEffect(() => (onShown ? () => onShown(null) : undefined), [onShown]);
  const [fullScreen, setFullScreen] = useState(false);
  const [element, setElement] = useState<HTMLElement | null>(null);
  const rowWidth = useParentWidth(element);
  const panel = useArtifactPanelParts({
    artifact: ready?.artifact,
    title,
    bytes: ready?.bytes,
    newestVersion: state.versions[0] ?? null,
  });
  // Any kind with an editor takes the room it can while it is being edited.
  const editable = !!useArtifactEditorKind(ready?.artifact);
  const editing = useArtifactEditing(ready ? artifactKey(ready.artifact) : "") && editable;
  const room = { wide: panel.wide || editable, expanded: editing };
  const layout = rowWidth === null ? null : artifactPanelLayout(rowWidth, room);
  const overlay = layout?.mode === "overlay";
  const splitWidth = layout?.mode === "split" ? layout.width : undefined;
  // A file the editor can show is edited in its studio (ADR 0024): Edit, or typing a change in
  // the ask box, opens it over the app; the panel stays open on the file underneath.
  const [studio, setStudio] = useState<{ draft?: AskDraft } | null>(null);
  const closeStudio = useCallback(() => setStudio(null), []);
  const studioCan = editable && !!ready?.artifact.botId;

  useEffect(() => {
    if (studio) return; // the studio has Escape while it is open
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || panel.holdsEscape) return;
      if (fullScreen) setFullScreen(false);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, fullScreen, panel.holdsEscape, studio]);

  return (
    <section
      ref={setElement}
      data-testid="artifact-panel"
      data-layout={fullScreen ? "full-screen" : (layout?.mode ?? "split")}
      aria-label={title || ready?.artifact.name || t`Artifact`}
      style={fullScreen ? undefined : { width: splitWidth }}
      className={cn(
        "fixed inset-0 z-50 flex min-h-0 flex-col overflow-hidden bg-background",
        !fullScreen &&
          overlay &&
          // A sheet over the Conversation, under the window's top bar (84px), not beside it.
          "md:absolute md:inset-x-0 md:top-[76px] md:bottom-0 md:z-30 md:m-2 md:rounded-[18px] md:shadow-float md:ring-[0.5px] md:ring-glass-line md:ring-inset md:motion-safe:animate-in md:motion-safe:fade-in md:motion-safe:slide-in-from-right-2",
        !fullScreen &&
          !overlay &&
          "md:relative md:inset-auto md:z-auto md:m-2 md:shrink-0 md:rounded-[18px] md:bg-glass md:ring-[0.5px] md:ring-glass-line md:ring-inset md:backdrop-blur-[30px] md:backdrop-saturate-[1.8]",
        !fullScreen && !layout && artifactPanelWidth(room),
        !fullScreen &&
          !overlay &&
          "md:motion-safe:transition-[width] md:motion-safe:duration-300 md:motion-safe:ease-out",
      )}
    >
      <ArtifactEditor
        content={state}
        panel={panel}
        title={title}
        page={page}
        onClose={onClose}
        fullScreen={{ on: fullScreen, toggle: () => setFullScreen((on) => !on) }}
        onEdit={studioCan ? () => setStudio({}) : undefined}
        onAskStart={studioCan ? (draft) => setStudio({ draft }) : undefined}
        leading={
          overlay && !fullScreen ? (
            <Button
              variant="ghost"
              size="sm"
              className="-ms-2 me-1 shrink-0 text-muted-foreground"
              onClick={onClose}
            >
              <ChevronLeft />
              {t`Back`}
            </Button>
          ) : null
        }
      />
      {studio && ready ? (
        <ArtifactStudio
          artifactId={ready.artifact.id}
          title={title}
          draft={studio.draft}
          onClose={closeStudio}
          returnFocus={opener}
        />
      ) : null}
    </section>
  );
}
