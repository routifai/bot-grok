import { useState } from "react";
import type { MuseRailView } from "../../components/AppRail";

/**
 * Which Muse screen (F1) is showing inside the shell. Kept as local state, not a
 * route: these screens live inside the single Conversation shell rather than
 * behind their own URLs.
 */
export function useMuseNav(initial: MuseRailView = "conversation") {
  const [view, setView] = useState<MuseRailView>(initial);
  return { view, setView };
}
