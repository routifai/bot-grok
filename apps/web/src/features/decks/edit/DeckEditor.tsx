import { useLingui } from "@lingui/react/macro";
import { Button, cn } from "@nova/ui-web";
import { Redo2, Undo2 } from "lucide-react";
import {
  type MutableRefObject,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  setComposerAttachment,
  useComposerAttachAvailable,
} from "../../../lib/composer-attachments";
import { RAIL_OPEN_W, RAIL_SLIM_W } from "../DeckRail";
import { buildDeckAsk, DECK_ASK_KIND } from "../deck-ask";
import { EditStage } from "./EditStage";
import { targetLabel } from "./edit-model";
import { EditNoticeBanner, StylePanel } from "./StylePanel";
import { type DeckEditSource, type PostToFrame, useDeckEditor } from "./useDeckEditor";

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/**
 * Edit mode of a deck: the stage with the edit bridge and the style panel. `bar` is the viewer's
 * slide navigation, kept under the stage. The deck's own source is never touched here; every
 * change goes through `useDeckEditor` as patches the engine applies.
 */
export function DeckEditor({
  artifact,
  html,
  title,
  active,
  frameRef,
  bar,
  onEdited,
  source,
}: {
  artifact: { id: string; version: number };
  html: string;
  title: string;
  active: number;
  frameRef: MutableRefObject<HTMLIFrameElement | null>;
  bar: ReactNode;
  onEdited?: (artifactId: string) => void;
  source?: DeckEditSource;
}) {
  const { t } = useLingui();
  const postRef = useRef<PostToFrame>(() => {});
  const post = useCallback<PostToFrame>((message) => postRef.current(message), []);
  const editor = useDeckEditor({
    deckKey: title,
    artifactId: artifact.id,
    version: artifact.version,
    html,
    onEdited,
    post,
    source,
  });
  const canAsk = useComposerAttachAvailable();
  const [asked, setAsked] = useState(false);

  // Undo / redo from the keyboard while focus is outside the frame (the bridge covers inside).
  const { undo, redo } = editor;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || isTypingTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === "z") {
        event.preventDefault();
        void (event.shiftKey ? redo() : undo());
      } else if (key === "y") {
        event.preventDefault();
        void redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  const words = {
    slide: t`Slide`,
    heading: t`Heading`,
    text: t`Text`,
    image: t`Image`,
    link: t`Link`,
    box: t`Box`,
  };
  const ask = useCallback(
    (notes: Record<string, string>) => {
      const list = editor.targets;
      if (!list.length) return;
      const request = buildDeckAsk({
        artifactId: editor.head.current.id,
        name: title,
        version: editor.head.current.version,
        noun: (n) => t`${n} elements`,
        elements: list.map((target) => ({
          id: target.id,
          label: targetLabel(target, words),
          slide: target.slide,
          text: target.text,
          style: target.computed,
          note: notes[target.id] ?? "",
        })),
      });
      setComposerAttachment(DECK_ASK_KIND, request);
      setAsked(true);
    },
    [editor.targets, editor.head, title, t],
  );
  // A different selection is a different ask.
  useEffect(() => {
    if (editor.targets.map((x) => x.id).join() !== "") setAsked(false);
  }, [editor.targets]);
  // Leaving edit mode takes its attachment with it.
  useEffect(() => () => setComposerAttachment(DECK_ASK_KIND, null), []);

  const selected = editor.targets.length > 0;
  return (
    <div className="@container relative flex min-w-0 flex-1">
      <div className="relative flex min-w-0 flex-1 flex-col">
        <div className="relative min-h-0 flex-1">
          <EditStage
            html={html}
            title={title}
            reloadKey={editor.reloadKey}
            active={active}
            selectedIds={editor.selectedIds}
            chipInset={RAIL_OPEN_W - RAIL_SLIM_W + 8}
            frameRef={frameRef}
            postRef={postRef}
            onMessage={editor.onFrameMessage}
          />
        </div>
        <div className="relative">
          {editor.notice ? (
            <div className="pointer-events-none absolute inset-x-3 bottom-full z-10 mb-2 flex justify-center">
              <div className="pointer-events-auto">
                <EditNoticeBanner
                  notice={editor.notice}
                  targets={editor.targets}
                  canAsk={canAsk}
                  onAsk={ask}
                  onDismissNotice={editor.dismissNotice}
                />
              </div>
            </div>
          ) : null}
          {bar}
          <div
            data-testid="deck-edit-toolbar"
            className="absolute inset-y-0 start-3 flex items-center gap-0.5"
          >
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              aria-label={t`Undo`}
              title={t`Undo`}
              disabled={!editor.canUndo || editor.saving}
              onClick={() => void editor.undo()}
            >
              <Undo2 />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              aria-label={t`Redo`}
              title={t`Redo`}
              disabled={!editor.canRedo || editor.saving}
              onClick={() => void editor.redo()}
            >
              <Redo2 />
            </Button>
          </div>
        </div>
      </div>
      {/* From about 900px wide the inspector column is reserved for the whole edit session (empty
          state, then the selection's controls), so the stage never reflows and nothing is ever
          covered. Narrower, the stage keeps its width and the controls are a sheet over the
          bottom edge, shown only while something is selected. */}
      <div
        className={cn(
          "absolute inset-x-2 bottom-2 z-20 flex max-h-[60%] justify-end",
          "@[900px]:static @[900px]:inset-auto @[900px]:block @[900px]:max-h-none @[900px]:w-[300px] @[900px]:shrink-0 @[900px]:overflow-hidden",
          selected ? "" : "@max-[899px]:hidden",
        )}
      >
        <div className="flex h-full max-h-full w-[288px] @[900px]:w-[300px] @[900px]:py-3 @[900px]:pe-3">
          <StylePanel
            targets={editor.targets}
            theme={editor.theme}
            slideCount={editor.theme?.slideCount ?? 0}
            canAsk={canAsk}
            asked={asked}
            focusAsk={editor.askRequest}
            onStyle={(changes, mode) => editor.applyStyle(changes, mode)}
            onAttributes={editor.setAttributes}
            onCommit={() => {
              editor.finishText();
              void editor.flush();
            }}
            onClose={() => post({ type: "nova:edit-select", ids: [] })}
            onRemove={editor.remove}
            onDuplicate={editor.duplicate}
            onAsk={ask}
            onDismissNotice={editor.dismissNotice}
          />
        </div>
      </div>
    </div>
  );
}
