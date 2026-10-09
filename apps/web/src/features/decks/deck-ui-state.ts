import { useSyncExternalStore } from "react";

// Deck UI state shared between the panel header (Edit toggle, Present, rendered through the
// artifact registry's `usePanel`) and the DeckViewer body. Keyed by the deck's file name so a
// new version of the same deck keeps its mode.

type DeckUi = { editing: boolean; presentRequest: number };
const NONE: DeckUi = { editing: false, presentRequest: 0 };
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

/** A counter the header bumps; the viewer enters present mode when it changes. */
export const useDeckPresentRequest = (key: string): number =>
  useSyncExternalStore(subscribe, () => read(key).presentRequest);
export const requestDeckPresent = (key: string): void =>
  write(key, { presentRequest: read(key).presentRequest + 1 });

/** Test helper. */
export const resetDeckUi = (): void => {
  states.clear();
  for (const listener of listeners) listener();
};
