import type { Activity, Artifact, RoundView, ToolFamily } from "@superchat/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TranscriptWork, TurnWork } from "../activity";

// The session panel's readings (ADR 0027): whether the newest reply from before Rounds has work,
// the files a Round saved, the kinds of tool the Conversation's work used, and whether the panel
// is open.

/** The reply the newest messages belong to, never an older one. Null when that reply has no
 * strip (a Round's work is in its own strip). */
export function newestTurn(work: TranscriptWork): TurnWork | null {
  for (const turn of work.turns.values()) if (turn.last) return turn;
  return null;
}

/** The Library rows of the files a Round saved (ADR 0029), in the Round's order; a file the
 * Library has not listed yet is left out until it is. */
export function roundOutputs(files: RoundView["files"], rows: readonly Artifact[]): Artifact[] {
  const seen = new Set<string>();
  return files.flatMap((file) => {
    const row = file.artifactId
      ? rows.find((r) => r.id === file.artifactId || r.groupId === file.artifactId)
      : undefined;
    if (!row || seen.has(row.id)) return [];
    seen.add(row.id);
    return [row];
  });
}

/** The order the families are listed in. */
const FAMILY_ORDER: readonly ToolFamily[] = ["web", "files", "decks", "shell", "browser"];

/** The kinds of tool the Conversation's work used, as the engine names them for each Activity
 * (a file's studio turns are the studio's own, ADR 0024). */
export function usedFamilies(activities: readonly Activity[]): ToolFamily[] {
  const seen = new Set<ToolFamily>();
  for (const activity of activities) {
    if (activity.source === "studio") continue;
    for (const family of activity.families ?? []) seen.add(family);
  }
  return FAMILY_ORDER.filter((family) => seen.has(family));
}

/** Where the viewer's choice to keep the panel closed is kept (this browser only). */
export const SESSION_PANEL_KEY = "superchat.sessionPanel.closed";

function readClosed(): boolean {
  try {
    return window.localStorage.getItem(SESSION_PANEL_KEY) === "1";
  } catch {
    return false;
  }
}

function writeClosed(closed: boolean): void {
  try {
    if (closed) window.localStorage.setItem(SESSION_PANEL_KEY, "1");
    else window.localStorage.removeItem(SESSION_PANEL_KEY);
  } catch {
    // Storage is off (a private window): the choice lasts for this page only.
  }
}

/**
 * Whether the session panel is open: it opens when work starts running, unless the viewer closed
 * it (remembered in this browser), and stays open until closed. Reopening forgets the choice.
 */
export function useSessionPanelOpen(running: boolean): {
  open: boolean;
  show: () => void;
  close: () => void;
} {
  const closedRef = useRef(readClosed());
  const [open, setOpen] = useState(() => running && !closedRef.current);
  useEffect(() => {
    if (running && !closedRef.current) setOpen(true);
  }, [running]);
  const show = useCallback(() => {
    closedRef.current = false;
    writeClosed(false);
    setOpen(true);
  }, []);
  const close = useCallback(() => {
    closedRef.current = true;
    writeClosed(true);
    setOpen(false);
  }, []);
  return { open, show, close };
}
