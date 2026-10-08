import type { ChatSummary, MessageFork, ThreadMessage } from "@aiden/contracts";
import { describe, expect, it } from "vitest";
import {
  filterForks,
  forkColorIndex,
  forkCounts,
  forkGroup,
  forkRows,
  forkTone,
  forkUnder,
  groupForks,
  gutterLayout,
} from "./forkModel";

function fork(overrides: Partial<MessageFork> = {}): MessageFork {
  return {
    chatId: "fork-a",
    title: "6.6% and margin",
    replies: 3,
    live: false,
    unread: false,
    state: "open",
    summary: null,
    createdAt: "2026-10-07T09:31:00.000Z",
    ...overrides,
  };
}

function message(id: string, text: string, forks?: MessageFork[]): ThreadMessage {
  return {
    id,
    threadId: "conv",
    seq: 0,
    role: "bot",
    blocks: [{ kind: "text", text }],
    createdAt: "2026-10-07T09:00:00.000Z",
    ...(forks ? { forks } : {}),
  };
}

function chat(overrides: Partial<ChatSummary>): ChatSummary {
  return {
    id: "fork-a",
    title: "6.6% and margin",
    start: "withContext",
    summary: null,
    archived: false,
    live: false,
    unread: false,
    anchorItemId: "m1",
    updatedAt: "2026-10-07T09:31:00.000Z",
    ...overrides,
  };
}

describe("fork colors", () => {
  it("gives a fork the same one of six colors every time, from its id", () => {
    const ids = Array.from({ length: 60 }, (_, i) => `conv_${i}`);
    for (const id of ids) {
      const index = forkColorIndex(id);
      expect(index).toBeGreaterThanOrEqual(1);
      expect(index).toBeLessThanOrEqual(6);
      expect(forkColorIndex(id)).toBe(index);
    }
    // Spread across the palette, not one color for all.
    expect(new Set(ids.map(forkColorIndex)).size).toBe(6);
  });

  it("keeps the color while open or working and turns grey once added or archived", () => {
    const index = forkColorIndex("fork-a");
    expect(forkTone({ chatId: "fork-a", status: "open" })).toBe(index);
    expect(forkTone({ chatId: "fork-a", status: "live" })).toBe(index);
    expect(forkTone({ chatId: "fork-a", status: "added" })).toBe("done");
    expect(forkTone({ chatId: "fork-a", status: "archived" })).toBe("done");
  });
});

describe("forkUnder", () => {
  it("draws nothing without forks", () => {
    expect(forkUnder(undefined)).toEqual({ kind: "none" });
    expect(forkUnder([])).toEqual({ kind: "none" });
  });

  it("draws one fork as a reply line", () => {
    const under = forkUnder([fork({ live: true })]);
    expect(under).toMatchObject({ kind: "stub", status: "live" });
  });

  it("draws several as one pill: open forks' pips first, three at most, the rest counted", () => {
    const under = forkUnder([
      fork({ chatId: "a", state: "added", replies: 1 }),
      fork({ chatId: "b", replies: 2 }),
      fork({ chatId: "c", live: true, replies: 3 }),
      fork({ chatId: "d", state: "archived", replies: 4 }),
      fork({ chatId: "e", replies: 5 }),
      fork({ chatId: "f", replies: 6 }),
    ]);
    // The archived fork is left out: it is found only in All forks.
    expect(under).toMatchObject({
      kind: "pill",
      total: 5,
      open: 4,
      more: 2,
      replies: 17,
      live: true,
    });
    if (under.kind !== "pill") throw new Error("expected a pill");
    expect(under.pips.map((pip) => pip.chatId)).toEqual(["b", "c", "e"]);
  });

  it("shows grey pips when every fork is added back", () => {
    const under = forkUnder([
      fork({ chatId: "a", state: "added" }),
      fork({ chatId: "b", state: "added" }),
    ]);
    if (under.kind !== "pill") throw new Error("expected a pill");
    expect(under.open).toBe(0);
    expect(under.pips.map((pip) => pip.tone)).toEqual(["done", "done"]);
  });

  it("leaves archived forks out: one left is a reply line, none left is nothing", () => {
    expect(
      forkUnder([fork({ chatId: "a" }), fork({ chatId: "b", state: "archived" })]),
    ).toMatchObject({ kind: "stub", fork: { chatId: "a" } });
    expect(
      forkUnder([
        fork({ chatId: "a", state: "archived" }),
        fork({ chatId: "b", state: "archived" }),
      ]),
    ).toEqual({ kind: "none" });
  });
});

describe("gutterLayout", () => {
  const forksById = new Map<string, MessageFork[]>([
    ["m1", [fork({ chatId: "a", state: "added" })]],
    ["m2", [fork({ chatId: "b", live: true }), fork({ chatId: "c" }), fork({ chatId: "d" })]],
  ]);

  it("puts one dot per message with forks at the message's middle, sized by count", () => {
    const layout = gutterLayout({
      rows: [
        { messageId: "m0", top: 0, height: 100 },
        { messageId: "m1", top: 100, height: 100 },
        { messageId: "m2", top: 700, height: 200 },
      ],
      forksById,
      scrollHeight: 1000,
      scrollTop: 500,
      clientHeight: 250,
    });
    expect(layout.marks.map((mark) => [mark.messageId, mark.at, mark.count])).toEqual([
      ["m1", 0.15, 1],
      ["m2", 0.8, 3],
    ]);
    expect(layout.marks[0]).toMatchObject({ done: true, tone: "done", live: false, size: 10 });
    expect(layout.marks[1]).toMatchObject({
      done: false,
      live: true,
      size: 14,
      tone: forkColorIndex("b"),
    });
    expect(layout.view).toEqual({ top: 0.5, height: 0.25 });
  });

  it("caps the dot size and keeps positions inside the strip", () => {
    const many = Array.from({ length: 20 }, (_, i) => fork({ chatId: `f${i}` }));
    const layout = gutterLayout({
      rows: [{ messageId: "m3", top: 990, height: 40 }],
      forksById: new Map([["m3", many]]),
      scrollHeight: 1000,
      scrollTop: 0,
      clientHeight: 2000,
    });
    expect(layout.marks[0]?.size).toBe(18);
    expect(layout.marks[0]?.at).toBeLessThanOrEqual(1);
    // Content shorter than the viewport: everything is in view.
    expect(layout.view).toEqual({ top: 0, height: 1 });
  });
});

describe("All forks", () => {
  const messages = [
    message("m1", "**6.4%**, set on 28 September", [
      fork({ chatId: "added-1", state: "added", replies: 4 }),
    ]),
  ];
  const chats = [
    chat({ id: "plain", anchorItemId: null, title: "Lunch ideas" }),
    chat({ id: "added-1", title: "Slide 7 chart type", updatedAt: "2026-10-06T10:00:00.000Z" }),
    chat({ id: "live-1", title: "Fees and minimums", live: true, anchorItemId: "far-back" }),
    chat({
      id: "arch-1",
      title: "Speaker notes",
      archived: true,
      updatedAt: "2026-09-01T10:00:00.000Z",
    }),
    chat({ id: "open-1", title: "Which four banks?", updatedAt: "2026-10-03T10:00:00.000Z" }),
  ];
  const rows = forkRows(chats, messages);

  it("lists only forks, with what the loaded Conversation knows of each", () => {
    expect(rows.map((row) => [row.chatId, row.status])).toEqual([
      ["live-1", "live"],
      ["added-1", "added"],
      ["open-1", "open"],
      ["arch-1", "archived"],
    ]);
    const added = rows.find((row) => row.chatId === "added-1");
    expect(added).toMatchObject({ anchorText: "6.4%, set on 28 September", replies: 4 });
    expect(rows.find((row) => row.chatId === "live-1")).toMatchObject({
      anchorText: null,
      replies: null,
    });
  });

  it("reads state, snippet, replies and Project from the chat row when the engine sends them", () => {
    const [row] = forkRows(
      [
        chat({
          id: "far",
          anchorItemId: "not-loaded",
          forkState: "added",
          anchorSnippet: "Draft 2 is ready…",
          replies: 6,
          project: { slug: "q3", name: "Q3 Pricing" },
        }),
      ],
      [],
    );
    expect(row).toMatchObject({
      status: "added",
      tone: "done",
      anchorText: "Draft 2 is ready…",
      replies: 6,
      project: { slug: "q3", name: "Q3 Pricing" },
    });
  });

  it("counts and filters by state, then searches the title and the anchor's text", () => {
    expect(forkCounts(rows)).toEqual({ all: 4, live: 1, open: 1, added: 1, archived: 1 });
    expect(filterForks(rows, { filter: "archived", query: "" }).map((row) => row.chatId)).toEqual([
      "arch-1",
    ]);
    expect(filterForks(rows, { filter: "all", query: "BANKS" }).map((row) => row.chatId)).toEqual([
      "open-1",
    ]);
    expect(filterForks(rows, { filter: "all", query: "28 sept" }).map((row) => row.chatId)).toEqual(
      ["added-1"],
    );
    expect(filterForks(rows, { filter: "open", query: "slide" })).toEqual([]);
  });

  it("groups by the day each fork last moved", () => {
    const now = new Date(2026, 9, 7, 12, 0);
    expect(forkGroup(new Date(2026, 9, 7, 8, 0).toISOString(), now)).toBe("today");
    expect(forkGroup(new Date(2026, 9, 6, 23, 0).toISOString(), now)).toBe("yesterday");
    expect(forkGroup(new Date(2026, 9, 2, 9, 0).toISOString(), now)).toBe("week");
    expect(forkGroup(new Date(2026, 8, 20, 9, 0).toISOString(), now)).toBe("earlier");
    const grouped = groupForks(
      [
        { ...rows[0]!, updatedAt: new Date(2026, 8, 1).toISOString() },
        { ...rows[1]!, updatedAt: new Date(2026, 9, 7, 9).toISOString() },
      ],
      now,
    );
    expect(grouped.map((group) => group.group)).toEqual(["today", "earlier"]);
  });
});
