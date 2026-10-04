import { describe, expect, it } from "vitest";
import { MessageBlock } from "./events.js";
import { isReplyCardKind, parseReplyCard, ReplyCardData } from "./reply-cards.js";

const valid = {
  sources: { items: [{ title: "A", url: "https://a.test" }] },
  compare: { columns: ["X"], rows: [{ label: "Row", cells: ["1"] }] },
  plan: { items: [{ text: "Do", status: "doing" }] },
  ask: { question: "Which?", options: [{ id: "a", label: "A" }] },
  quote: { symbol: "ACME", price: 12.5, changePct: -1.2 },
  chart: { kind: "line", x: ["a"], series: [{ name: "s", values: [1] }] },
  person: { name: "Ada" },
  file: { name: "r.pdf", size: 10 },
  progress: { label: "Import", value: 40, status: "running" },
} as const;

describe("reply cards", () => {
  it("has a fixture for every kind", () => {
    expect(Object.keys(valid).sort()).toEqual(Object.keys(ReplyCardData).sort());
  });

  it.each(Object.entries(valid))("parses a valid %s card", (card, data) => {
    expect(parseReplyCard({ card, data })?.kind).toBe(card);
  });

  it("rejects unknown kinds and malformed data so the fallback is drawn", () => {
    expect(parseReplyCard({ card: "hologram", data: {} })).toBeNull();
    expect(parseReplyCard({ card: "quote", data: { symbol: "A" } })).toBeNull();
    expect(
      parseReplyCard({ card: "progress", data: { ...valid.progress, value: 101 } }),
    ).toBeNull();
    expect(isReplyCardKind("toString")).toBe(false);
  });

  it("persists an unknown kind as a block without failing the message", () => {
    const block = { kind: "reply_card", card: "hologram", data: { x: 1 }, fallback: "text" };
    expect(MessageBlock.safeParse(block).success).toBe(true);
  });
});
