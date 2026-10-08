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
});
