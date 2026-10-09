import { describe, expect, it } from "vitest";
import type { OmnigentTranscriptPage } from "./client/transcript.js";
import { mapTranscriptPage } from "./transcript.js";

const page = (data: OmnigentTranscriptPage["data"], hasMore = false): OmnigentTranscriptPage => ({
  data,
  has_more: hasMore,
  older_cursor: hasMore ? "cursor-1" : null,
  lineage: { kind: "super", root_id: "s1", parent_id: null, seed_item_id: null },
});

describe("mapTranscriptPage", () => {
  it("maps each engine block onto the chat's existing block types", () => {
    const result = mapTranscriptPage(
      "s1",
      page([
        { id: "m1", role: "user", created_at: 100, blocks: [{ type: "text", text: "hi" }] },
        {
          id: "m2",
          role: "assistant",
          created_at: 101,
          blocks: [
            { type: "text", text: "On it." },
            {
              type: "helper",
              call_id: "c1",
              session_id: "h1",
              title: "Research",
              status: "running",
            },
          ],
        },
        {
          id: "m3",
          role: "assistant",
          created_at: 102,
          blocks: [
            {
              type: "card",
              card_id: "q1",
              card: { card: "quote", id: "q1", data: { n: 1 }, fallback: "n 1" },
              pending: true,
            },
          ],
        },
        {
          id: "m4",
          role: "assistant",
          created_at: 103,
          blocks: [
            {
              type: "file",
              artifact_id: "a1",
              name: "plan.md",
              mime: "text/markdown",
              kind: "markdown",
              size: 12,
              version: 2,
            },
          ],
        },
        {
          id: "m5",
          role: "assistant",
          created_at: 104,
          blocks: [{ type: "secure_entry", request_id: "r1", name: "Login", site: "example.test" }],
        },
        {
          id: "m6",
          role: "assistant",
          created_at: 105,
          blocks: [{ type: "error", code: "x", level: "info" }],
        },
      ]),
    );
    expect(result.messages.map((message) => message.role)).toEqual([
      "user",
      "bot",
      "bot",
      "bot",
      "bot",
      "bot",
    ]);
    expect(result.messages[0]?.createdAt).toBe("1970-01-01T00:01:40.000Z");
    expect(result.messages[1]?.blocks).toEqual([
      { kind: "text", text: "On it." },
      { kind: "helper", helperId: "h1", title: "Research" },
    ]);
    expect(result.messages[2]?.blocks).toEqual([
      {
        kind: "reply_card",
        card: "quote",
        id: "q1",
        data: { n: 1 },
        fallback: "n 1",
        pending: true,
      },
    ]);
    expect(result.messages[3]?.blocks[0]).toMatchObject({
      kind: "reply_card",
      card: "file",
      id: "artifact:a1",
      data: { name: "plan.md", artifactId: "a1", kind: "markdown", size: 12, version: 2 },
    });
    expect(result.messages[4]?.blocks[0]).toMatchObject({
      kind: "reply_card",
      card: "secure_entry",
      data: { requestId: "r1", name: "Login", site: "example.test" },
    });
    expect(result.messages[5]?.blocks).toEqual([{ kind: "error", code: "x", level: "info" }]);
  });

  it("pages back with the engine's cursor and reports a live chat", () => {
    expect(mapTranscriptPage("s1", { ...page([], true), live: true })).toMatchObject({
      threadId: "s1",
      olderItemCursor: "cursor-1",
      running: true,
    });
    expect(mapTranscriptPage("s1", page([])).olderItemCursor).toBeNull();
  });

  it("passes the engine's reset checkpoint through, and none when there is none", () => {
    const cleared = mapTranscriptPage("s1", {
      ...page([]),
      reset: { item_id: "r1", created_at: 60 },
    });
    expect(cleared.reset).toEqual({ itemId: "r1", createdAt: new Date(60_000).toISOString() });
    expect(mapTranscriptPage("s1", page([])).reset).toBeNull();
  });

  it("maps a message's forks, an added fork's summary and a fork's lineage", () => {
    const result = mapTranscriptPage("f1", {
      ...page([
        {
          id: "m1",
          role: "assistant",
          created_at: 100,
          blocks: [
            { type: "text", text: "6.4%." },
            {
              type: "fork_summary",
              fork_id: "f2",
              anchor_item_id: "m1",
              title: "Slide 7",
              summary: "Bars by segment",
            },
          ],
          forks: [
            {
              session_id: "f2",
              title: "Slide 7",
              replies: 4,
              live: false,
              unread: true,
              state: "added",
              summary: "Bars by segment",
              created_at: 90,
            },
          ],
        },
        { id: "m2", role: "user", created_at: 101, blocks: [{ type: "text", text: "ok" }] },
      ]),
      lineage: {
        kind: "side",
        root_id: "s1",
        parent_id: "s1",
        seed_item_id: null,
        anchor_item_id: "m0",
      },
    });
    expect(result.messages[0]?.blocks[1]).toEqual({
      kind: "fork_summary",
      forkId: "f2",
      anchorItemId: "m1",
      title: "Slide 7",
      summary: "Bars by segment",
    });
    expect(result.messages[0]?.forks).toEqual([
      {
        chatId: "f2",
        title: "Slide 7",
        replies: 4,
        live: false,
        unread: true,
        state: "added",
        summary: "Bars by segment",
        createdAt: new Date(90_000).toISOString(),
      },
    ]);
    // A message the engine sent without forks stays without the field.
    expect(result.messages[1]?.forks).toBeUndefined();
    expect(result.lineage).toEqual({ rootId: "s1", parentId: "s1", anchorItemId: "m0" });
  });
  it("marks a file the person delivered, and leaves the Muse's own saves unmarked", () => {
    const file = { type: "file" as const, artifact_id: "a1", name: "q3.pptx", mime: null };
    const result = mapTranscriptPage(
      "s1",
      page([
        { id: "m1", role: "assistant", created_at: 1, blocks: [{ ...file, by: "user" }] },
        { id: "m2", role: "assistant", created_at: 2, blocks: [{ ...file, artifact_id: "a2" }] },
      ]),
    );
    const data = (i: number) => {
      const block = result.messages[i]?.blocks[0];
      return block?.kind === "reply_card" ? block.data : null;
    };
    expect(data(0)).toMatchObject({ artifactId: "a1", byYou: true });
    expect(data(1)).not.toHaveProperty("byYou");
  });

  describe("a file card repeating a saved artifact", () => {
    const saved = {
      id: "m2",
      role: "assistant" as const,
      created_at: 2,
      blocks: [
        {
          type: "file" as const,
          artifact_id: "a1",
          name: "nova.html",
          mime: "text/html",
          kind: "html",
          size: 5200,
          version: 1,
        },
      ],
    };
    const fileCard = (id: string, artifactId: string, version?: number) => ({
      id,
      role: "assistant" as const,
      created_at: 3,
      blocks: [
        {
          type: "card" as const,
          card_id: null,
          card: {
            card: "file",
            data: { name: "nova.html", kind: "html", artifactId, ...(version ? { version } : {}) },
            fallback: "f",
          },
        },
      ],
    });
    const user = { id: "u", role: "user" as const, created_at: 1, blocks: [] };
    const done = {
      id: "m4",
      role: "assistant" as const,
      created_at: 4,
      blocks: [{ type: "text" as const, text: "Done." }],
    };

    it("shows the artifact once, with its size", () => {
      const result = mapTranscriptPage("s1", page([user, saved, fileCard("m3", "a1", 1), done]));
      expect(result.messages.map((m) => m.id)).toEqual(["u", "m2", "m4"]);
      expect(result.messages[1]?.blocks[0]).toMatchObject({ data: { size: 5200 } });
    });

    it("keeps a card for another artifact or another version", () => {
      const result = mapTranscriptPage(
        "s1",
        page([user, saved, fileCard("m3", "a2"), fileCard("m5", "a1", 2)]),
      );
      expect(result.messages.map((m) => m.id)).toEqual(["u", "m2", "m3", "m5"]);
    });

    it("shows the card again in a later turn", () => {
      const result = mapTranscriptPage(
        "s1",
        page([user, saved, { ...user, id: "u2" }, fileCard("m3", "a1", 1)]),
      );
      expect(result.messages.map((m) => m.id)).toEqual(["u", "m2", "u2", "m3"]);
    });
  });
});
