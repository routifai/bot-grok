import { useLingui } from "@lingui/react/macro";
import { Button, cn } from "@superchat/ui-web";
import { ChevronLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { ArtifactEditor } from "./editor/ArtifactEditor";
import { artifactKey, useArtifactEditing } from "./editor/editor-state";
import { useArtifactContent } from "./library/useArtifactContent";
import { artifactPanelLayout, useParentWidth } from "./panel-layout";
import { useArtifactEditorKind, useArtifactPanelParts } from "./registry";

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
  onClose,
}: {
  artifactId: string;
  title?: string;
  /** Open a PDF at this page (a citation chip). */
  page?: number;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const state = useArtifactContent(artifactId);
  const ready = state.status === "ready" ? state : null;
  const [fullScreen, setFullScreen] = useState(false);
  const [element, setElement] = useState<HTMLElement | null>(null);
  const rowWidth = useParentWidth(element);
  const panel = useArtifactPanelParts({ artifact: ready?.artifact, title, bytes: ready?.bytes });
  // Any kind with an editor takes the room it can while it is being edited.
  const editable = !!useArtifactEditorKind(ready?.artifact);
  const editing = useArtifactEditing(ready ? artifactKey(ready.artifact) : "") && editable;
  const room = { wide: panel.wide || editable, expanded: editing };
  const layout = rowWidth === null ? null : artifactPanelLayout(rowWidth, room);
  const overlay = layout?.mode === "overlay";
  const splitWidth = layout?.mode === "split" ? layout.width : undefined;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || panel.holdsEscape) return;
      if (fullScreen) setFullScreen(false);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, fullScreen, panel.holdsEscape]);

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
    </section>
  );
}
