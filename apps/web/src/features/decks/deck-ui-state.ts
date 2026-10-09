import { useSyncExternalStore } from "react";

// Deck UI state shared between the panel header (Edit toggle, Present, rendered through the
// artifact registry's `usePanel`) and the DeckViewer body. Keyed by the deck's file name so a
// new version of the same deck keeps its mode.

type DeckUi = { editing: boolean; presentRequest: number; themeOpen: boolean };
const NONE: DeckUi = { editing: false, presentRequest: 0, themeOpen: false };
const states = new Map<string, DeckUi>();
const listeners = new Set<() => void>();

const read = (key: string): DeckUi => states.get(key) ?? NONE;
function write(key: string, patch: Partial<DeckUi>): void {
  states.set(key, { ...read(key), ...patch });
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export const useDeckEditing = (key: string): boolean =>
  useSyncExternalStore(subscribe, () => read(key).editing);
export const setDeckEditing = (key: string, editing: boolean): void => write(key, { editing });

/** Whether the Theme gallery is open (the header's Theme button toggles it; the viewer shows it). */
export const useDeckThemeOpen = (key: string): boolean =>
  useSyncExternalStore(subscribe, () => read(key).themeOpen);
export const readDeckThemeOpen = (key: string): boolean => read(key).themeOpen;
export const setDeckThemeOpen = (key: string, themeOpen: boolean): void =>
  write(key, { themeOpen });

/** A counter the header bumps; the viewer enters present mode when it changes. */
export const useDeckPresentRequest = (key: string): number =>
  useSyncExternalStore(subscribe, () => read(key).presentRequest);
export const requestDeckPresent = (key: string): void =>
  write(key, { presentRequest: read(key).presentRequest + 1 });

// Edits made outside the editor (the Theme gallery) that the editor's undo history should own,
// and the editor's way to save what it still has staged before such a change is made.
const outsideEdits = new Map<string, Set<number>>();
type Head = { id: string; version: number };
const flushers = new Map<string, () => Promise<Head>>();

/** Says the saved `version` of a deck was an edit of the person's, so Undo can step back over it. */
export function noteDeckVersionEdit(key: string, version: number): void {
  if (!flushers.has(key)) return; // only a mounted editor keeps history; nothing piles up otherwise
  outsideEdits.set(key, (outsideEdits.get(key) ?? new Set()).add(version));
}
/** True once (and forgets) when `version` was noted by `noteDeckVersionEdit`. */
export function takeDeckVersionEdit(key: string, version: number): boolean {
  return outsideEdits.get(key)?.delete(version) ?? false;
}
/** The editor registers how to save its staged changes; returns the unregister. */
export function registerDeckFlush(key: string, flush: () => Promise<Head>): () => void {
  flushers.set(key, flush);
  return () => {
    if (flushers.get(key) !== flush) return;
    flushers.delete(key);
    outsideEdits.delete(key);
  };
}
/** Saves what the editor still has staged for this deck; its newest saved version, or null when
 * it is not editing. */
export const flushDeckEdits = async (key: string): Promise<Head | null> =>
  (await flushers.get(key)?.()) ?? null;

/** Test helper. */
export const resetDeckUi = (): void => {
  states.clear();
  outsideEdits.clear();
  flushers.clear();
  for (const listener of listeners) listener();
};
