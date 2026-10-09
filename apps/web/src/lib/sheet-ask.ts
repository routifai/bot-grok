import { useEffect, useSyncExternalStore } from "react";

/** A selection from a sheet the person wants Nova to look at: the chip label the composer shows
 * and the engine's untrusted-data block that travels ahead of their message. */
export type SheetAsk = { label: string; block: string };

let ask: SheetAsk | null = null;
let composers = 0;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export function setSheetAsk(next: SheetAsk | null): void {
  ask = next;
  emit();
}

export const useSheetAsk = (): SheetAsk | null => useSyncExternalStore(subscribe, () => ask);

/** Registers a mounted composer, so a sheet only offers "Ask Nova" when there is one to ask in. */
export function useSheetAskTarget(): void {
  useEffect(() => {
    composers += 1;
    emit();
    return () => {
      composers -= 1;
      emit();
    };
  }, []);
}

export const useSheetAskAvailable = (): boolean =>
  useSyncExternalStore(subscribe, () => composers > 0);

/** The message as sent: the selection block first, then what the person wrote. */
export const withSheetAsk = (text: string, current: SheetAsk | null): string =>
  current ? (text ? `${current.block}\n\n${text}` : current.block) : text;
