import type { Artifact } from "@superchat/contracts";
import { useSyncExternalStore } from "react";

// Editor state shared between the parts of one open artifact that do not sit in one React tree
// branch: the shell's Edit toggle, the panel that widens while editing, and a kind's own controls
// (a deck's Theme gallery) that save versions the editor's history should own. Keyed by
// `artifactKey`, so a new version of the same file keeps its mode.

/** Where one file's editor state lives: its name under its Muse. A version has its own id and the
 * web has no family id, so the name is what every version shares. */
export const artifactKey = (artifact: Pick<Artifact, "botId" | "name">): string =>
  `${artifact.botId ?? ""}:${artifact.name}`;

const editing = new Map<string, boolean>();
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** Whether the file is in edit mode (select, type, style) rather than viewing / running. */
export const useArtifactEditing = (key: string): boolean =>
  useSyncExternalStore(subscribe, () => editing.get(key) ?? false);
export function setArtifactEditing(key: string, on: boolean): void {
  if ((editing.get(key) ?? false) === on) return;
  editing.set(key, on);
  notify();
}

// Versions saved outside the editor (a deck's Theme switch) that its undo history should own, and
// the editor's way to save what it still has staged before such a change is made.
type Head = { id: string; version: number };
const ownVersions = new Map<string, Set<number>>();
const flushers = new Map<string, () => Promise<Head>>();

/** Says the saved `version` was an edit of the person's, so Undo can step back over it. */
export function noteOwnVersion(key: string, version: number): void {
  if (!flushers.has(key)) return; // only a mounted editor keeps history; nothing piles up otherwise
  ownVersions.set(key, (ownVersions.get(key) ?? new Set()).add(version));
}
/** True once (and forgets) when `version` was noted by `noteOwnVersion`. */
export function takeOwnVersion(key: string, version: number): boolean {
  return ownVersions.get(key)?.delete(version) ?? false;
}
/** The editor registers how to save its staged changes; returns the unregister. */
export function registerEditorFlush(key: string, flush: () => Promise<Head>): () => void {
  flushers.set(key, flush);
  return () => {
    if (flushers.get(key) !== flush) return;
    flushers.delete(key);
    ownVersions.delete(key);
  };
}
/** Saves what the editor still has staged for this file; its newest saved version, or null when
 * no editor is mounted. */
export const flushEditorEdits = async (key: string): Promise<Head | null> =>
  (await flushers.get(key)?.()) ?? null;

/** Test helper. */
export function resetEditorState(): void {
  editing.clear();
  ownVersions.clear();
  flushers.clear();
  notify();
}
