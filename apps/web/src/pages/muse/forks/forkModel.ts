// Forks (ADR 0010, CONTEXT.md "Fork"): the pure rules the fork UI draws from. Colors, the stub or
// pill under a message, the gutter's dots, and the All forks list's rows, filters and groups.
import type { ChatSummary, MessageFork, ThreadMessage } from "@aiden/contracts";

/** `fork-1`…`fork-6`, or `done` (grey) for a fork that was added back or archived. */
export type ForkTone = 1 | 2 | 3 | 4 | 5 | 6 | "done";

/** A fork's state as the person reads it: `live` is an open fork Nova is working in. */
export type ForkStatus = "live" | "open" | "added" | "archived";

/** Static class names per tone (the fork tokens, `ink-3` for done), so Tailwind sees them. */
export const FORK_TONE_CLASS: Record<
  ForkTone,
  { text: string; bg: string; border: string; fill: string }
> = {
  1: { text: "text-fork-1", bg: "bg-fork-1", border: "border-fork-1", fill: "fill-fork-1" },
  2: { text: "text-fork-2", bg: "bg-fork-2", border: "border-fork-2", fill: "fill-fork-2" },
  3: { text: "text-fork-3", bg: "bg-fork-3", border: "border-fork-3", fill: "fill-fork-3" },
  4: { text: "text-fork-4", bg: "bg-fork-4", border: "border-fork-4", fill: "fill-fork-4" },
  5: { text: "text-fork-5", bg: "bg-fork-5", border: "border-fork-5", fill: "fill-fork-5" },
  6: { text: "text-fork-6", bg: "bg-fork-6", border: "border-fork-6", fill: "fill-fork-6" },
  done: { text: "text-ink-3", bg: "bg-ink-3", border: "border-ink-3", fill: "fill-ink-3" },
};

/** A stable 1…6 for a fork id (FNV-1a), so a fork keeps its color everywhere and across loads. */
export function forkColorIndex(chatId: string): 1 | 2 | 3 | 4 | 5 | 6 {
  let hash = 0x811c9dc5;
  for (let i = 0; i < chatId.length; i += 1) {
    hash ^= chatId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (((hash >>> 0) % 6) + 1) as 1 | 2 | 3 | 4 | 5 | 6;
}

/** Open and working forks keep their color; once added back or archived they turn grey, so only
 * the forks still in play are ever colored. */
export function forkTone(fork: { chatId: string; status: ForkStatus }): ForkTone {
  return fork.status === "added" || fork.status === "archived"
    ? "done"
    : forkColorIndex(fork.chatId);
}

export function messageForkStatus(fork: Pick<MessageFork, "state" | "live">): ForkStatus {
  if (fork.state !== "open") return fork.state;
  return fork.live ? "live" : "open";
}

const isOpen = (status: ForkStatus) => status === "live" || status === "open";

/** What sits under a message: nothing, one fork's reply line, or one pill for several. */
export type ForkUnder =
  | { kind: "none" }
  | { kind: "stub"; fork: MessageFork; tone: ForkTone; status: ForkStatus }
  | {
      kind: "pill";
      /** Up to three colored pips: the open forks first, else the first forks. */
      pips: Array<{ chatId: string; tone: ForkTone }>;
      /** Forks past the pips. */
      more: number;
      total: number;
      open: number;
      replies: number;
      live: boolean;
    };

export const MAX_PIPS = 3;

export function forkUnder(forks: readonly MessageFork[] | undefined): ForkUnder {
  if (!forks?.length) return { kind: "none" };
  const rows = forks.map((fork) => {
    const status = messageForkStatus(fork);
    return { fork, status, tone: forkTone({ chatId: fork.chatId, status }) };
  });
  if (rows.length === 1) {
    const [only] = rows;
    if (only) return { kind: "stub", ...only };
  }
  const open = rows.filter((row) => isOpen(row.status));
  const pips = (open.length ? open : rows)
    .slice(0, MAX_PIPS)
    .map((row) => ({ chatId: row.fork.chatId, tone: row.tone }));
  return {
    kind: "pill",
    pips,
    more: rows.length - pips.length,
    total: rows.length,
    open: open.length,
    replies: rows.reduce((sum, row) => sum + row.fork.replies, 0),
    live: rows.some((row) => row.status === "live"),
  };
}

/** One dot of the gutter: a message with forks, where it sits along the Conversation. */
export type GutterMark = {
  messageId: string;
  /** Center, as a fraction (0…1) of the scrolled content's height. */
  at: number;
  /** Dot diameter in px, by how many forks the message has. */
  size: number;
  count: number;
  /** Its first open fork's color; `done` when every fork is added back or archived. */
  tone: ForkTone;
  live: boolean;
  done: boolean;
};

export type GutterLayout = {
  marks: GutterMark[];
  /** The visible part of the Conversation, as fractions of its height. */
  view: { top: number; height: number };
};

const GUTTER_DOT_MIN = 10;
const GUTTER_DOT_MAX = 18;

/**
 * Where the gutter's dots go: one per message with forks, at that message's middle relative to
 * the whole scrolled height (measured from the DOM by the caller), plus the band for what is in
 * view. Pure, so it is tested without a browser.
 */
export function gutterLayout({
  rows,
  forksById,
  scrollHeight,
  scrollTop,
  clientHeight,
}: {
  /** Each rendered message's box, relative to the top of the scrolled content. */
  rows: ReadonlyArray<{ messageId: string; top: number; height: number }>;
  forksById: ReadonlyMap<string, readonly MessageFork[]>;
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}): GutterLayout {
  const total = Math.max(scrollHeight, clientHeight, 1);
  const marks: GutterMark[] = [];
  for (const row of rows) {
    const forks = forksById.get(row.messageId);
    if (!forks?.length) continue;
    const statuses = forks.map((fork) => ({
      chatId: fork.chatId,
      status: messageForkStatus(fork),
    }));
    const firstOpen = statuses.find((fork) => isOpen(fork.status));
    marks.push({
      messageId: row.messageId,
      at: clamp01((row.top + row.height / 2) / total),
      size: Math.min(GUTTER_DOT_MAX, GUTTER_DOT_MIN + (forks.length - 1) * 2),
      count: forks.length,
      tone: firstOpen ? forkTone(firstOpen) : "done",
      live: statuses.some((fork) => fork.status === "live"),
      done: !firstOpen,
    });
  }
  return {
    marks,
    view: { top: clamp01(scrollTop / total), height: clamp01(clientHeight / total) },
  };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

/** A fork as the sidebar and the All forks list show it. */
export type ForkRow = {
  chat: ChatSummary;
  chatId: string;
  title: string;
  status: ForkStatus;
  tone: ForkTone;
  anchorItemId: string;
  /** The anchor message's text (the engine's snippet, else the loaded message's). */
  anchorText: string | null;
  replies: number | null;
  /** The Project the fork has open. */
  project: { slug: string; name: string } | null;
  unread: boolean;
  updatedAt: string;
};

/**
 * The Muse's forks: its Side Chats that have an anchor. The chat list row carries each fork's
 * state, anchor snippet, replies and Project; a row from before the engine sent those falls back
 * to what the loaded Conversation knows (added back or not, replies, the anchor's text).
 */
export function forkRows(
  chats: readonly ChatSummary[],
  messages: readonly ThreadMessage[],
): ForkRow[] {
  const known = new Map<string, { fork: MessageFork; anchor: ThreadMessage }>();
  for (const message of messages) {
    for (const fork of message.forks ?? []) known.set(fork.chatId, { fork, anchor: message });
  }
  const rows: ForkRow[] = [];
  for (const chat of chats) {
    if (!chat.anchorItemId) continue;
    const seen = known.get(chat.id);
    const state = chat.forkState ?? (chat.archived ? "archived" : seen?.fork.state);
    const status: ForkStatus =
      state === "archived" || chat.archived
        ? "archived"
        : state === "added"
          ? "added"
          : chat.live
            ? "live"
            : "open";
    rows.push({
      chat,
      chatId: chat.id,
      title: chat.title || seen?.fork.title || "",
      status,
      tone: forkTone({ chatId: chat.id, status }),
      anchorItemId: chat.anchorItemId,
      anchorText: chat.anchorSnippet || (seen ? messagePlainText(seen.anchor) : null),
      replies: chat.replies ?? seen?.fork.replies ?? null,
      project: chat.project ?? null,
      unread: Boolean(chat.unread),
      updatedAt: chat.updatedAt,
    });
  }
  return rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/** A message's words, on one line, without markdown emphasis: for "from “…”" lines. */
export function messagePlainText(message: ThreadMessage): string {
  return message.blocks
    .flatMap((block) => (block.kind === "text" ? [block.text] : []))
    .join(" ")
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export type ForkFilter = "all" | ForkStatus;
export const FORK_FILTERS: readonly ForkFilter[] = ["all", "live", "open", "added", "archived"];

export function forkCounts(rows: readonly ForkRow[]): Record<ForkFilter, number> {
  const counts: Record<ForkFilter, number> = {
    all: rows.length,
    live: 0,
    open: 0,
    added: 0,
    archived: 0,
  };
  for (const row of rows) counts[row.status] += 1;
  return counts;
}

/** The All forks list: one state (or all), then a search over the title and the anchor text. */
export function filterForks(
  rows: readonly ForkRow[],
  { filter, query }: { filter: ForkFilter; query: string },
): ForkRow[] {
  const needle = query.trim().toLocaleLowerCase();
  return rows.filter(
    (row) =>
      (filter === "all" || row.status === filter) &&
      (!needle || `${row.title} ${row.anchorText ?? ""}`.toLocaleLowerCase().includes(needle)),
  );
}

export type ForkGroup = "today" | "yesterday" | "week" | "earlier";
export const FORK_GROUPS: readonly ForkGroup[] = ["today", "yesterday", "week", "earlier"];

/** When a fork last moved, by local calendar day: Today, Yesterday, This week (the last seven
 * days), Earlier. */
export function forkGroup(iso: string, now: Date): ForkGroup {
  const day = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "earlier";
  const days = Math.round((day(now) - day(then)) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return "week";
  return "earlier";
}

export function groupForks(
  rows: readonly ForkRow[],
  now: Date,
): Array<{ group: ForkGroup; rows: ForkRow[] }> {
  const groups = new Map<ForkGroup, ForkRow[]>();
  for (const row of rows) {
    const group = forkGroup(row.updatedAt, now);
    groups.set(group, [...(groups.get(group) ?? []), row]);
  }
  return FORK_GROUPS.flatMap((group) => {
    const inGroup = groups.get(group);
    return inGroup ? [{ group, rows: inGroup }] : [];
  });
}
