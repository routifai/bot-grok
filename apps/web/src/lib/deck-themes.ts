import type { DeckTheme } from "@nova/contracts";
import { useEffect, useState } from "react";
import { rpc } from "./rpc";

export type DeckThemesSource = () => Promise<{ themes: DeckTheme[]; defaultTheme: string }>;

const defaultSource: DeckThemesSource = () => rpc.decks.themes({});

/** One fetch of the dictionary per page load: the thumbnails are a few hundred KB. */
let cache: Promise<{ themes: DeckTheme[]; defaultTheme: string }> | null = null;
export function loadDeckThemes(source: DeckThemesSource = defaultSource) {
  cache ??= source().catch((error: unknown) => {
    cache = null;
    throw error;
  });
  return cache;
}
/** Test helper. */
export const resetDeckThemeCache = (): void => {
  cache = null;
};

/** The theme dictionary (fetched only when `enabled`), null while it loads or can't be read. */
export function useDeckThemes(enabled = true): DeckTheme[] | null {
  const [themes, setThemes] = useState<DeckTheme[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    loadDeckThemes().then(
      (found) => live && setThemes(found.themes),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [enabled]);
  return themes;
}
