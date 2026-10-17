import type { ArtifactVersion, ThreadMessage } from "@superchat/contracts";
import { splitElementAsk } from "../editor/html-ask";

// A file's studio thread (ADR 0024): the studio session's transcript merged with the file's
// version list by time. No new item kind: requests, replies and the engine's runtime notes
// (system messages: "Super Chat saved v9 while you were editing…") come from the transcript, hand
// edits and version markers from the versions.

/** A runtime line that records a version (`[you] … · v3`, `[Super Chat] saved v9`, `[live
 * update] …`, engine `studio.notice_line`): the version list already draws it, so the thread
 * does not repeat it. Other runtime lines (a stale notice) are notes. */
const VERSION_RECORD = /^\[[^\]\n]+\] /;

/** Who made a version, in the studio's five words. */
export type VersionOrigin = "chat" | "superchat" | "you" | "restored" | "updated";

export type StudioRow =
  /** The person's request, with the element chip it was sent with. */
  | { kind: "me"; id: string; text: string; chip: string | null; at: number }
  /** The assistant's reply. */
  | { kind: "ai"; id: string; text: string; at: number }
  /** A runtime note from the engine: a version saved elsewhere during a turn. */
  | { kind: "note"; id: string; text: string; at: number }
  /** Edits by hand: one version, or a run of consecutive ones on one element. */
  | {
      kind: "hand";
      id: string;
      summary: string;
      element: string | null;
      count: number;
      from: number;
      to: number;
      versionIds: string[];
      at: number;
    }
  /** A version was saved. */
  | { kind: "version"; id: string; version: number; origin: VersionOrigin; at: number };

/** Who made `version`, seen from the studio session `studioId`. */
export function versionOrigin(version: ArtifactVersion, studioId: string | null): VersionOrigin {
  if (version.origin === "manual") return "you";
  if (version.origin === "restore") return "restored";
  if (version.origin === "update") return "updated";
  return version.fromStudio || (studioId !== null && version.chatId === studioId)
    ? "chat"
    : "superchat";
}

/** The element a hand edit changed, from its summary: `slide 3 title`, `slide 2 (cover)`,
 * `add-button`. Null when the summary names none. */
export function editedElement(summary: string | null | undefined): string | null {
  const match = /^(slide \d+ (?:\([^)]*\)|[^\s,:]+)|[^\s,:]+)/.exec((summary ?? "").trim());
  return match?.[1] ?? null;
}

const time = (iso: string): number => {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? 0 : at;
};

function messageText(message: ThreadMessage): string {
  return message.blocks
    .map((block) => (block.kind === "text" ? block.text : ""))
    .join("\n")
    .trim();
}

/**
 * The studio thread, oldest first. A version saved by this chat sits after the reply of the turn
 * that saved it (the turn's request is its `itemId`); every other version at the time it was
 * saved. Consecutive hand edits to one element read as one row.
 */
export function studioThread(
  messages: readonly ThreadMessage[],
  versions: readonly ArtifactVersion[],
  studioId: string | null,
): StudioRow[] {
  const rows: StudioRow[] = [];
  const replyAfter = new Map<string, number>();
  let lastRequest: string | null = null;
  for (const message of messages) {
    const text = messageText(message);
    if (!text) continue;
    const at = time(message.createdAt);
    if (message.role === "user") {
      const ask = splitElementAsk(text);
      rows.push({
        kind: "me",
        id: message.id,
        text: ask ? ask.rest : text,
        chip: ask?.label ?? null,
        at,
      });
      lastRequest = message.id;
    } else if (message.role === "bot") {
      rows.push({ kind: "ai", id: message.id, text, at });
      if (lastRequest !== null && !replyAfter.has(lastRequest)) replyAfter.set(lastRequest, at);
    } else if (!VERSION_RECORD.test(text)) {
      rows.push({ kind: "note", id: message.id, text, at });
    }
  }
  for (const version of [...versions].reverse()) {
    const origin = versionOrigin(version, studioId);
    let at = time(version.createdAt);
    if (origin === "chat" && version.itemId) {
      const reply = replyAfter.get(version.itemId);
      if (reply !== undefined && reply >= at) at = reply + 0.5;
    }
    if (origin === "you") {
      rows.push({
        kind: "hand",
        id: `hand:${version.id}`,
        summary: version.editSummary ?? "",
        element: editedElement(version.editSummary),
        count: 1,
        from: version.version,
        to: version.version,
        versionIds: [version.id],
        at,
      });
    }
    rows.push({ kind: "version", id: version.id, version: version.version, origin, at });
  }
  // Stable: a request before its own reply, a hand edit before its marker.
  const sorted = rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => a.row.at - b.row.at || a.index - b.index)
    .map(({ row }) => row);
  return collapseHandEdits(sorted);
}

/** Folds `hand, marker, hand, marker` on one element into one hand row and its last marker. */
function collapseHandEdits(rows: StudioRow[]): StudioRow[] {
  const out: StudioRow[] = [];
  for (const row of rows) {
    const marker = out.at(-1);
    const previous = out.at(-2);
    if (
      row.kind === "hand" &&
      row.element !== null &&
      marker?.kind === "version" &&
      marker.origin === "you" &&
      previous?.kind === "hand" &&
      previous.element === row.element &&
      marker.version === previous.to
    ) {
      out.pop();
      out[out.length - 1] = {
        ...previous,
        count: previous.count + row.count,
        to: row.to,
        versionIds: [...previous.versionIds, ...row.versionIds],
      };
      continue;
    }
    out.push(row);
  }
  return out;
}

/** "3 edits · v1 to v4": the person's requests and hand edits, and the versions they span. */
export function threadSummary(rows: readonly StudioRow[]): {
  edits: number;
  first: number;
  last: number;
} | null {
  let edits = 0;
  let first = Number.POSITIVE_INFINITY;
  let last = 0;
  for (const row of rows) {
    if (row.kind === "me") edits += 1;
    else if (row.kind === "hand") edits += row.count;
    else if (row.kind === "version") {
      first = Math.min(first, row.version);
      last = Math.max(last, row.version);
    }
  }
  return edits > 0 && last > 0 ? { edits, first, last } : null;
}
