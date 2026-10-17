import { useLingui } from "@lingui/react/macro";
import type { Artifact, ArtifactVersion } from "@superchat/contracts";
import {
  Button,
  cn,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
} from "@superchat/ui-web";
import {
  Check,
  Download,
  ExternalLink,
  Maximize2,
  Minimize2,
  Pencil,
  Redo2,
  Undo2,
  X,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { SuperchatOrb } from "../../../components/ai/orb";
import { artifactKind, kindLabel } from "../../../lib/artifact-kind";
import { downloadArtifactBytes, opensInNewTab } from "../../../lib/artifact-open";
import { rpc } from "../../../lib/rpc";
import { useObjectUrl } from "../../../lib/use-object-url";
import { readableFileName } from "../ArtifactFileCard";
import { ArtifactPreview } from "../ArtifactPreview";
import type { AskDraft } from "../ask/AskBox";
import { AskBox } from "../ask/AskBox";
import { useArtifactAsk } from "../ask/useArtifactAsk";
import type { useArtifactContent } from "../library/useArtifactContent";
import { PanelOverflowMenu } from "../PanelOverflowMenu";
import {
  type ArtifactEditorArgs,
  type ArtifactEditorKind,
  type ArtifactEditorParts,
  useArtifactEditorKind,
  type useArtifactPanelParts,
} from "../registry";
import {
  artifactKey,
  isHandOrigin,
  setArtifactEditing,
  setArtifactLocked,
  useArtifactEditing,
} from "./editor-state";
import { buildFileAsk } from "./html-ask";
import { VersionMenu } from "./VersionMenu";

export type ArtifactContent = ReturnType<typeof useArtifactContent>;
type PanelParts = ReturnType<typeof useArtifactPanelParts>;

/** What the frame around the editor (the side panel, a dialog, the Library sheet) hands it. */
export type ArtifactEditorProps = {
  content: ArtifactContent;
  /** The registry's panel parts for this file (badges, Publish, bars, dialogs). */
  panel: PanelParts;
  /** A title the opener knows (a card's); the file's own title otherwise. */
  title?: string;
  /** Open a PDF at this page (a citation chip). */
  page?: number;
  /** At the start of the header: "Back", "‹ Library". */
  leading?: ReactNode;
  onClose: () => void;
  /** The frame can go full screen (a "Full screen" item in `⋯`). */
  fullScreen?: { on: boolean; toggle: () => void };
  /** Edit opens the file's studio instead of editing here (the side panel, ADR 0024). */
  onEdit?: () => void;
  /** Typing in the ask box opens the file's studio with what was typed and the caret. */
  onAskStart?: (draft: AskDraft) => void;
  /** The editor inside the file's studio (ADR 0024). */
  studio?: StudioSlot;
};

/** What the file's studio hands the editor it hosts. */
export type StudioSlot = {
  /** The studio chat session: the ask box sends there, not to the Conversation. */
  chatId: string;
  /** The column beside the editor, given the editor's ask box to place in it. */
  aside: (askBox: ReactNode) => ReactNode;
  /** A studio turn is running (seen from its chat): the canvas takes no hand edits. */
  locked?: boolean;
  /** Words a version's origin in the version menu. */
  versionOrigin?: (version: ArtifactVersion) => string;
  /** Typed in the panel before the studio opened. */
  draft?: AskDraft;
};

/** Focus is where the person types: keyboard shortcuts leave the key to it. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/** The file's display title: its own title, else a readable file name. */
export function artifactTitle(artifact: Pick<Artifact, "name" | "description">): string {
  return artifact.description?.trim() || readableFileName(artifact.name);
}

/**
 * The one editor for every artifact kind. The shell owns the header (title, "<Kind> · version N"
 * menu, Edit, the kind's actions, `⋯`, one close), the edit toolbar (undo, redo, ask, done), the
 * ask box and the layout: navigator | stage (+ ask box) | inspector. A kind with an editor
 * (`ArtifactExtension.editor`: a deck, a page) fills the slots; every other file opens read-only
 * in the same shell, its preview on the stage and the ask box about the whole file.
 */
export function ArtifactEditor(props: ArtifactEditorProps) {
  const { t } = useLingui();
  const { content } = props;
  const ready = content.status === "ready" ? content : null;
  const kind = useArtifactEditorKind(ready?.artifact);
  if (!ready) {
    return (
      <EditorFrame
        {...props}
        heading={props.title || t`Loading…`}
        body={
          content.status === "error" ? (
            <div className="grid h-full place-items-center px-6 text-center text-[13.5px] text-destructive">
              {content.message}
            </div>
          ) : (
            <div className="grid h-full place-items-center text-[13.5px] text-muted-foreground">
              {t`Loading…`}
            </div>
          )
        }
      />
    );
  }
  // Keyed by kind and file, not version: a new version keeps the mode, the selection and the
  // edit history instead of starting the editor over.
  const key = `${kind?.id ?? "file"}:${ready.artifact.name}`;
  return kind ? (
    <KindEditor key={key} {...props} artifact={ready.artifact} bytes={ready.bytes} kind={kind} />
  ) : (
    <FileEditor key={key} {...props} artifact={ready.artifact} bytes={ready.bytes} />
  );
}

type LoadedProps = ArtifactEditorProps & { artifact: Artifact; bytes: Uint8Array };

const NO_PANEL_PARTS: PanelParts = {
  badge: null,
  actions: null,
  below: null,
  overlay: null,
  overflow: null,
  versionNote: null,
  wide: false,
  holdsEscape: false,
  hasOverflow: false,
  hasVersionNote: false,
};

/**
 * One file in the editor without the version machinery or the registry's panel parts: the dev
 * page and tests drive a kind through the real shell this way.
 */
export function ArtifactEditorView({
  artifact,
  bytes,
  kind,
  onEdited,
  onClose = () => {},
}: {
  artifact: Artifact;
  bytes: Uint8Array;
  kind: ArtifactEditorKind;
  onEdited?: (artifactId: string) => void;
  onClose?: () => void;
}) {
  const content: ArtifactContent = {
    status: "ready",
    artifact,
    bytes,
    versions: [],
    versionId: artifact.id,
    selectVersion: () => {},
    adoptVersion: onEdited ?? (() => {}),
    newer: null,
    showNewest: () => {},
    arrived: null,
  };
  return (
    <KindEditor
      key={`${kind.id}:${artifact.name}`}
      content={content}
      panel={NO_PANEL_PARTS}
      onClose={onClose}
      artifact={artifact}
      bytes={bytes}
      kind={kind}
    />
  );
}

function KindEditor({ kind, ...props }: LoadedProps & { kind: ArtifactEditorKind }) {
  const { artifact } = props;
  const fileKey = artifactKey(artifact);
  const editing = useArtifactEditing(fileKey);
  const [askClicks, setAskClicks] = useState(0);
  const focusAsk = useCallback(() => setAskClicks((n) => n + 1), []);
  const setEditing = useCallback((on: boolean) => setArtifactEditing(fileKey, on), [fileKey]);
  const useEditor = kind.useEditor;
  const parts = useEditor({
    artifact,
    bytes: props.bytes,
    editing,
    setEditing,
    onEdited: props.content.adoptVersion,
    focusAsk,
  } satisfies ArtifactEditorArgs);
  return (
    <LoadedEditor
      {...props}
      parts={parts}
      editing={editing && parts.editable}
      setEditing={setEditing}
      askClicks={askClicks}
      focusAsk={focusAsk}
      kindId={kind.id}
    />
  );
}

function FileEditor(props: LoadedProps) {
  const { t } = useLingui();
  const { artifact, bytes } = props;
  const [askClicks, setAskClicks] = useState(0);
  const focusAsk = useCallback(() => setAskClicks((n) => n + 1), []);
  const whole = t`Whole file`;
  const contextBlock = useCallback(
    () =>
      buildFileAsk({
        artifactId: artifact.id,
        name: artifact.name,
        version: artifact.version,
        label: whole,
      }).block,
    [artifact.id, artifact.name, artifact.version, whole],
  );
  const parts: ArtifactEditorParts = {
    label: kindLabel(artifactKind(artifact.mimeType, artifact.name)),
    editable: false,
    stage: (
      <ArtifactPreview
        artifact={artifact}
        bytes={bytes}
        onEdited={props.content.adoptVersion}
        page={props.page}
      />
    ),
    ask: {
      chips: [],
      placeholder: t`Ask superchat to change this file…`,
      contextBlock,
    },
  };
  return (
    <LoadedEditor
      {...props}
      parts={parts}
      editing={false}
      setEditing={() => {}}
      askClicks={askClicks}
      focusAsk={focusAsk}
      kindId="file"
    />
  );
}

function LoadedEditor({
  artifact,
  bytes,
  content,
  panel,
  parts,
  editing,
  setEditing,
  askClicks,
  kindId,
  ...props
}: LoadedProps & {
  parts: ArtifactEditorParts;
  editing: boolean;
  setEditing: (on: boolean) => void;
  askClicks: number;
  focusAsk: () => void;
  /** The editor kind's id ("deck", "page", ...; "file" for a read-only file). */
  kindId: string;
}) {
  const { t } = useLingui();
  const url = useObjectUrl(bytes, artifact.mimeType);
  const { history } = parts;
  // Leaving edit mode first saves a text edit still in progress; a failed save stays in edit mode
  // with its notice.
  const leaveEditing = () =>
    void (history?.finish?.() ?? Promise.resolve()).then(
      () => setEditing(false),
      () => {},
    );
  const botId = artifact.botId;
  const studio = props.studio;
  const ask = useArtifactAsk({
    artifact: botId
      ? {
          id: artifact.id,
          name: artifact.name,
          version: artifact.version,
          botId,
          chatId: studio?.chatId,
        }
      : null,
    contextBlock: parts.ask.contextBlock,
  });
  // While a studio turn runs the canvas is read-only: no inspector, and the kind refuses saves.
  const fileKey = artifactKey(artifact);
  const locked = !!studio && (!!studio.locked || ask.running);
  useEffect(() => {
    if (!studio) return;
    setArtifactLocked(fileKey, locked);
    return () => setArtifactLocked(fileKey, false);
  }, [studio, fileKey, locked]);
  const sendAsk = useCallback(
    async (text: string) => {
      await history?.flush(); // what is staged by hand is saved first, so superchat works on it
      history?.expectAsk(true);
      const sent = await ask.send(text, history?.headVersion());
      if (!sent) history?.expectAsk(false);
      return sent;
    },
    [history, ask.send],
  );
  // The ask settled (answered, failed, stopped): a version after this is not its answer.
  const expectAsk = history?.expectAsk;
  const askSettled = ask.status.kind !== "sending" && ask.status.kind !== "editing";
  useEffect(() => {
    if (askSettled) expectAsk?.(false);
  }, [askSettled, expectAsk]);

  // Undo / redo from the keyboard while focus is outside the frame (the bridge covers inside).
  const undo = history?.undo;
  const redo = history?.redo;
  useEffect(() => {
    if (!editing || !undo || !redo) return;
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
  }, [editing, undo, redo]);

  const restore = useCallback(async () => {
    if (!content.versionId) return;
    await history?.flush(); // what is staged by hand is saved first, so the restore comes after it
    const created = await rpc.artifacts.restore({ artifactId: content.versionId });
    content.adoptVersion(created.id);
  }, [content, history]);

  const actions = (
    <>
      {parts.editable ? (
        <Button
          variant={editing ? "default" : "secondary"}
          size="sm"
          aria-pressed={editing}
          data-testid="editor-edit"
          onClick={() =>
            props.onEdit ? props.onEdit() : editing ? leaveEditing() : setEditing(true)
          }
        >
          <Pencil size={13} />
          {t`Edit`}
        </Button>
      ) : null}
      {parts.actions}
      {panel.actions}
      {parts.ownsDownload ? null : (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t`Download`}
          title={t`Download`}
          className="text-muted-foreground"
          onClick={() => downloadArtifactBytes(artifact.name, artifact.mimeType, bytes)}
        >
          <Download />
        </Button>
      )}
      <PanelOverflowMenu>
        <DropdownMenuGroup>
          <DropdownMenuLabel className="max-w-64 truncate font-normal text-muted-foreground">
            {artifact.name}
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        {panel.overflow}
        {parts.overflow}
        {url && opensInNewTab(artifact.mimeType) ? (
          <DropdownMenuItem render={<a href={url} target="_blank" rel="noreferrer noopener" />}>
            <ExternalLink />
            {t`Open in new tab`}
          </DropdownMenuItem>
        ) : null}
        {props.fullScreen ? (
          <DropdownMenuItem onClick={props.fullScreen.toggle}>
            {props.fullScreen.on ? <Minimize2 /> : <Maximize2 />}
            {props.fullScreen.on ? t`Exit full screen` : t`Full screen`}
          </DropdownMenuItem>
        ) : null}
      </PanelOverflowMenu>
    </>
  );

  const meta = (
    <>
      <VersionMenu
        kindLabel={parts.label}
        version={artifact.version}
        versions={content.versions}
        shownId={content.versionId}
        onPick={content.selectVersion}
        onRestore={restore}
        note={panel.hasVersionNote ? panel.versionNote : undefined}
        originOf={studio?.versionOrigin}
      />
      {panel.badge ? (
        // Tags ("Published", "Live") give way first when the header is narrow; the bars below
        // still say both.
        <span className="flex shrink-0 items-center gap-2 @max-[18rem]:hidden">{panel.badge}</span>
      ) : null}
      {content.arrived ? (
        <span
          data-testid="artifact-arrived"
          className="shrink-0 truncate text-[12px] text-foreground"
        >
          {isHandOrigin(content.arrived.origin)
            ? t`Updated by you · v${content.arrived.version}`
            : t`Updated by superchat · v${content.arrived.version}`}
        </span>
      ) : null}
      {content.newer ? (
        <button
          type="button"
          data-testid="artifact-newer"
          onClick={content.showNewest}
          className="shrink-0 rounded-full bg-accent px-2 py-0.5 text-[12px] text-foreground hover:bg-accent/70"
        >
          {t`Newer version available, show it`}
        </button>
      ) : null}
    </>
  );

  const selected = parts.ask.chips.length > 0;
  const toolbar =
    editing && history ? (
      <div className="flex shrink-0 justify-center px-3 pt-2.5 pb-1">
        <div
          role="toolbar"
          aria-label={t`Editing`}
          data-testid="editor-toolbar"
          className="superchat-glass-pill flex items-center gap-0.5 rounded-full p-1"
        >
          <Button
            variant="ghost"
            size="icon-sm"
            className="rounded-full"
            aria-label={t`Undo`}
            title={t`Undo (⌘Z)`}
            disabled={!history.canUndo || history.saving}
            onClick={() => void history.undo()}
          >
            <Undo2 />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="rounded-full"
            aria-label={t`Redo`}
            title={t`Redo (⇧⌘Z)`}
            disabled={!history.canRedo || history.saving}
            onClick={() => void history.redo()}
          >
            <Redo2 />
          </Button>
          <Button size="sm" className="ms-1 rounded-full" onClick={leaveEditing}>
            <Check />
            {t`Done`}
          </Button>
        </div>
      </div>
    ) : null;

  const askBox = ask.available ? (
    <AskBox
      className={studio ? undefined : "mx-auto max-w-[760px]"}
      chips={parts.ask.chips}
      onRemoveChip={parts.ask.onRemoveChip}
      placeholder={parts.ask.placeholder}
      focusRequest={askClicks + (parts.ask.focusRequest ?? 0)}
      status={ask.status}
      onSend={sendAsk}
      onStop={() => void ask.stop()}
      onUndo={
        history
          ? () => {
              ask.dismiss();
              void history.undo();
            }
          : undefined
      }
      canUndo={history?.canUndo}
      onStartTyping={props.onAskStart}
      initialDraft={studio?.draft}
    />
  ) : null;

  const body = (
    <div className="@container relative flex min-h-0 flex-1">
      {parts.navigator}
      <div className="relative flex min-w-0 flex-1 flex-col">
        {toolbar}
        <div className="relative min-h-0 flex-1">
          {parts.stage}
          {locked ? (
            // A page or a deck keeps selecting through the lit layer (the kind refuses saves);
            // any other kind's canvas takes no input until the turn ends.
            <WorkingCanvas slides={kindId === "deck"} selectable={SELECTABLE_KINDS.has(kindId)} />
          ) : null}
        </div>
        {parts.footer}
        <div className="relative">
          {parts.notice ? (
            <div className="pointer-events-none absolute inset-x-3 bottom-full z-10 mb-2 flex justify-center">
              <div className="pointer-events-auto">{parts.notice}</div>
            </div>
          ) : null}
          {askBox && !studio ? <div className="px-4 pt-1 pb-3">{askBox}</div> : null}
        </div>
      </div>
      {/* From about 900px wide the inspector column is reserved for the whole edit session (empty
          state, then the selection's controls), so the stage never reflows and nothing is ever
          covered. Narrower, the stage keeps its width and the controls are a sheet over the
          bottom edge, shown only while something is selected. */}
      {editing && parts.inspector && !locked ? (
        <div
          data-testid="editor-inspector"
          className={cn(
            "absolute inset-x-2 bottom-2 z-20 flex max-h-[60%] justify-end",
            "@[900px]:static @[900px]:inset-auto @[900px]:block @[900px]:max-h-none @[900px]:w-[300px] @[900px]:shrink-0 @[900px]:overflow-hidden",
            selected ? "" : "@max-[899px]:hidden",
          )}
        >
          <div className="flex h-full max-h-full w-[288px] @[900px]:w-[300px] @[900px]:py-3 @[900px]:pe-3">
            {parts.inspector}
          </div>
        </div>
      ) : null}
      {studio ? studio.aside(askBox) : null}
    </div>
  );

  return (
    <EditorFrame
      {...props}
      content={content}
      panel={panel}
      heading={props.title || artifactTitle(artifact)}
      fileName={artifact.name}
      meta={meta}
      actions={actions}
      body={body}
    />
  );
}

/** Kinds whose canvas keeps selecting while a studio turn runs: their saves go through the HTML
 * editor, which refuses them while the file is locked. */
const SELECTABLE_KINDS = new Set(["deck", "page"]);

/** ADR 0023's working state over the canvas while a studio turn changes the file. */
function WorkingCanvas({ slides, selectable }: { slides: boolean; selectable: boolean }) {
  const { t } = useLingui();
  return (
    <div
      data-testid="studio-working"
      className={cn(
        "sc-work absolute inset-2 z-10 flex items-center justify-center",
        selectable ? "pointer-events-none" : "pointer-events-auto",
      )}
      data-live=""
    >
      <div className="absolute inset-[1.5px] rounded-[12.5px] bg-content/55 backdrop-blur-[2px]" />
      <div
        role="status"
        className="relative flex items-center gap-2 rounded-full bg-content px-3 py-1.5 text-[13px] text-foreground shadow-float"
      >
        <SuperchatOrb size={16} state="working" flies={false} />
        {slides ? t`superchat is updating this slide…` : t`superchat is updating this file…`}
      </div>
    </div>
  );
}

/** The header row and the body under it. */
function EditorFrame({
  heading,
  fileName,
  meta,
  actions,
  body,
  leading,
  panel,
  onClose,
  studio,
}: ArtifactEditorProps & {
  heading: string;
  fileName?: string;
  meta?: ReactNode;
  actions?: ReactNode;
  body: ReactNode;
}) {
  const { t } = useLingui();
  return (
    <div data-testid="artifact-editor" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex min-w-0 shrink-0 items-center gap-1.5 border-b border-border px-4 py-2.5">
        {leading}
        <div className="@container flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          <h2
            data-testid="artifact-editor-title"
            title={fileName}
            dir="auto"
            className="min-w-16 truncate text-[14px] font-semibold"
          >
            {heading}
          </h2>
          {meta}
        </div>
        {actions}
        {studio ? null : (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t`Close`}
            className="text-muted-foreground"
            onClick={onClose}
          >
            <X />
          </Button>
        )}
      </header>
      {panel.below}
      {panel.overlay}
      {body}
    </div>
  );
}
