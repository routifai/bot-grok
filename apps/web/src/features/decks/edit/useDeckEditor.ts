// Portions modified from nexu-io/open-design apps/web/src/edit-mode/source-patches.ts@802708f, Apache-2.0; changes: the patches are applied by the engine (Python); this hook batches them into versions and keeps a version-aware undo/redo stack.
import type {
  Artifact,
  DeckEditFromFrame,
  DeckEditTarget,
  DeckEditTheme,
  DeckPatch,
} from "@nova/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { rpc } from "../../../lib/rpc";
import { registerDeckFlush, takeDeckVersionEdit } from "../deck-ui-state";
import { type CommitOutcome, Committer } from "./committer";
import {
  isInexact,
  isStale,
  readTranslate,
  type StyleChanges,
  stylePatches,
  withTranslate,
} from "./edit-model";

/** The call the editor makes; the API by default (a fake in tests). */
export type DeckEditSource = (input: {
  artifactId: string;
  baseVersion: number;
  patches: DeckPatch[];
}) => Promise<Pick<Artifact, "id" | "version">>;

const defaultSource: DeckEditSource = (input) => rpc.decks.edit(input);

export type EditNotice = { kind: "stale" | "inexact" | "failed"; message: string };

type Kind = "edit" | "undo" | "redo";
const HISTORY_MAX = 50;

/** Posts a host message to the live frame (adds the protocol version and nonce). */
export type PostToFrame = (message: Record<string, unknown>) => void;

/**
 * The deck editor's brain: what is selected, how changes become saved versions, and undo / redo.
 * Every change shows at once in the frame (a preview) and is saved as a `manual` version through
 * one `Committer`; undo and redo save the earlier source back as a new version, so history is
 * always version-aware and a change from Nova ends it (the older sources would clobber hers).
 */
export function useDeckEditor({
  deckKey,
  artifactId,
  version,
  html,
  onEdited,
  post,
  source = defaultSource,
}: {
  /** The deck's file name: where outside edits and the flush hook are registered. */
  deckKey: string;
  artifactId: string;
  version: number;
  /** The source of the version on screen. */
  html: string;
  onEdited?: (artifactId: string) => void;
  post: PostToFrame;
  source?: DeckEditSource;
}) {
  const [targets, setTargets] = useState<DeckEditTarget[]>([]);
  const [theme, setTheme] = useState<DeckEditTheme | null>(null);
  const [notice, setNotice] = useState<EditNotice | null>(null);
  const [textEditing, setTextEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [undoStack, setUndoStack] = useState<string[]>([]);
  const [redoStack, setRedoStack] = useState<string[]>([]);
  const [askRequest, setAskRequest] = useState(0);

  const undoStackRef = useRef(undoStack);
  undoStackRef.current = undoStack;
  const redoStackRef = useRef(redoStack);
  redoStackRef.current = redoStack;
  const saved = useRef({ id: artifactId, version });
  const seen = useRef({ version, html });
  const own = useRef(new Map<number, Kind>());
  const intent = useRef<Kind>("edit");
  const selectedIds = useRef<string[]>([]);
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const onEditedRef = useRef(onEdited);
  onEditedRef.current = onEdited;
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const postRef = useRef(post);
  postRef.current = post;

  // A new version on screen: ours extends the history, anyone else's ends it.
  useEffect(() => {
    if (version === seen.current.version) return;
    const before = seen.current.html;
    let kind = own.current.get(version);
    if (!kind && takeDeckVersionEdit(deckKey, version)) {
      kind = "edit"; // the Theme gallery's switch: Undo steps back over it
      saved.current = { id: artifactId, version };
    }
    if (kind) {
      own.current.delete(version);
      if (kind === "edit") {
        setUndoStack((stack) => [...stack, before].slice(-HISTORY_MAX));
        setRedoStack([]);
      } else if (kind === "undo") setRedoStack((stack) => [...stack, before].slice(-HISTORY_MAX));
      else setUndoStack((stack) => [...stack, before].slice(-HISTORY_MAX));
    } else {
      setUndoStack([]);
      setRedoStack([]);
      saved.current = { id: artifactId, version };
    }
    seen.current = { version, html };
  }, [artifactId, version, html, deckKey]);

  const save = useCallback(async (patches: DeckPatch[]): Promise<CommitOutcome> => {
    const base = saved.current;
    const kind: Kind = patches.some((p) => p.kind === "set-full-source") ? intent.current : "edit";
    intent.current = "edit";
    setSaving(true);
    try {
      const created = await sourceRef.current({
        artifactId: base.id,
        baseVersion: base.version,
        patches,
      });
      saved.current = { id: created.id, version: created.version };
      own.current.set(created.version, kind);
      setNotice(null);
      onEditedRef.current?.(created.id);
      return { ok: true };
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : "";
      const code = (failure as { code?: unknown })?.code;
      if (code === "CONFLICT" && isInexact(message)) {
        setNotice({ kind: "inexact", message });
      } else if (code === "CONFLICT" || isStale(message)) {
        setNotice({ kind: "stale", message });
      } else {
        setNotice({ kind: "failed", message });
      }
      setReloadKey((n) => n + 1); // the preview no longer matches the source: show the source
      return { ok: false, message };
    } finally {
      setSaving(false);
    }
  }, []);

  const committer = useMemo(() => new Committer(save), [save]);
  // Leaving edit mode (or the deck) saves whatever is still staged.
  useEffect(() => () => void committer.commit(), [committer]);
  useEffect(
    () =>
      registerDeckFlush(deckKey, async () => {
        await committer.commit();
        return saved.current;
      }),
    [deckKey, committer],
  );

  const preview = useCallback((patches: readonly DeckPatch[]) => {
    for (const patch of patches) {
      if (patch.kind === "set-style")
        postRef.current({ type: "nova:edit-preview", id: patch.id, style: patch.style });
    }
  }, []);

  /** Style changes for the selection: shown now, saved after a quiet moment (or at once). */
  const applyStyle = useCallback(
    (changes: StyleChanges, mode: "later" | "now" = "later") => {
      const list = targetsRef.current;
      if (!list.length) return;
      const patches = stylePatches(list, changes);
      preview(patches);
      if (mode === "now") void committer.commit(patches);
      else committer.stage(patches);
    },
    [committer, preview],
  );

  const flush = useCallback(() => committer.commit(), [committer]);

  const setAttributes = useCallback(
    (attributes: { href?: string | null; alt?: string | null }) => {
      const patches: DeckPatch[] = targetsRef.current.map((t) => ({
        kind: "set-attributes",
        id: t.id,
        attributes,
      }));
      committer.stage(patches);
    },
    [committer],
  );

  const nudge = useCallback(
    (dx: number, dy: number) => {
      for (const t of targetsRef.current) {
        const at = readTranslate(t.inline.transform);
        const next = withTranslate(t.inline.transform, { x: at.x + dx, y: at.y + dy });
        const patches = stylePatches([t], { transform: next });
        preview(patches);
        committer.stage(patches);
      }
    },
    [committer, preview],
  );

  const removeSelected = useCallback(() => {
    const list = targetsRef.current;
    if (!list.length) return;
    // The last slide cannot go (the engine refuses it too); say so here without a round trip.
    void committer.commit(list.map((t) => ({ kind: "remove-element", id: t.id })));
    selectedIds.current = [];
  }, [committer]);

  const duplicateSelected = useCallback(() => {
    const list = targetsRef.current;
    if (!list.length) return;
    void committer.commit(list.map((t) => ({ kind: "duplicate-element", id: t.id })));
  }, [committer]);

  const undo = useCallback(async () => {
    await committer.commit();
    const previous = undoStackRef.current.at(-1);
    if (previous === undefined) return;
    setUndoStack((stack) => stack.slice(0, -1));
    intent.current = "undo";
    await committer.commit([{ kind: "set-full-source", source: previous }]);
  }, [committer]);

  const redo = useCallback(async () => {
    await committer.commit();
    const next = redoStackRef.current.at(-1);
    if (next === undefined) return;
    setRedoStack((stack) => stack.slice(0, -1));
    intent.current = "redo";
    await committer.commit([{ kind: "set-full-source", source: next }]);
  }, [committer]);
  /** The bridge's messages (already validated and nonce-checked by the stage). */
  const onFrameMessage = useCallback(
    (message: DeckEditFromFrame) => {
      switch (message.type) {
        case "nova:edit-ready":
          setTheme(message.theme);
          break;
        case "nova:edit-selection":
          setTargets(message.targets);
          selectedIds.current = message.targets.map((t) => t.id);
          break;
        case "nova:edit-text-session":
          setTextEditing(message.active);
          break;
        case "nova:edit-text-commit":
          void committer.commit([{ kind: "set-text", id: message.id, text: message.text }]);
          break;
        case "nova:edit-ask":
          setAskRequest((n) => n + 1);
          break;
        case "nova:edit-key":
          if (message.action === "undo") void undo();
          else if (message.action === "redo") void redo();
          else if (message.action === "delete") removeSelected();
          else if (message.action === "duplicate") duplicateSelected();
          else nudge(message.dx ?? 0, message.dy ?? 0);
          break;
      }
    },
    [committer, undo, redo, removeSelected, duplicateSelected, nudge],
  );

  return {
    targets,
    theme,
    notice,
    dismissNotice: () => setNotice(null),
    textEditing,
    saving,
    reloadKey,
    selectedIds,
    askRequest,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    head: saved,
    applyStyle,
    setAttributes,
    flush,
    undo,
    redo,
    remove: removeSelected,
    duplicate: duplicateSelected,
    onFrameMessage,
    finishText: () => postRef.current({ type: "nova:edit-text-finish", commit: true }),
  };
}
