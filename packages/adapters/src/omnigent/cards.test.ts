import { describe, expect, it } from "vitest";
import {
  isRenderCardCall,
  redactReplyCard,
  replyCardFromToolCall,
  toolOutputsByCallId,
  turnBlocks,
} from "./cards.js";
import { mapOmnigentItemsToMessages } from "./chats.js";

const args = {
  card: "quote",
  id: "q1",
  data: { symbol: "ACME", price: 12.5 },
  fallback: "ACME 12.5",
};
const call = (callId: string, name = "render_card") => ({
  id: `i-${callId}`,
  type: "function_call",
  name,
  arguments: JSON.stringify(args),
  call_id: callId,
});
const result = { type: "card", ...args };
const output = (callId: string, body: unknown = result) => ({
  id: `o-${callId}`,
  type: "function_call_output",
  call_id: callId,
  output: JSON.stringify(body),
});
const reply = (text: string) => ({
  id: "m1",
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text }],
});

describe("replyCardFromToolCall", () => {
  it("builds the block from the engine's validated output", () => {
    expect(replyCardFromToolCall(call("c1"), JSON.stringify(result))).toEqual({
      kind: "reply_card",
      card: "quote",
      id: "q1",
      data: args.data,
      fallback: "ACME 12.5",
    });
  });

  it("is pending (skeleton) until the output arrives", () => {
    expect(replyCardFromToolCall(call("c1"), undefined)).toMatchObject({
      card: "quote",
      pending: true,
      data: {},
    });
  });

  it("shows nothing for a failed call", () => {
    expect(replyCardFromToolCall(call("c1"), JSON.stringify({ error: "bad" }))).toBeNull();
    expect(replyCardFromToolCall(call("c1"), "not json")).toBeNull();
  });

  it("recognises the tool behind a harness prefix only", () => {
    expect(isRenderCardCall(call("c", "mcp__omnigent__render_card"))).toBe(true);
    expect(isRenderCardCall(call("c", "web_search"))).toBe(false);
    expect(isRenderCardCall(call("c", "not_render_card"))).toBe(false);
  });
});

describe("turnBlocks", () => {
  it("keeps card order around the final reply and drops pending cards", () => {
    const items = [call("a"), output("a"), reply("One line."), call("b"), output("b"), call("c")];
    expect(turnBlocks(items, "One line.").map((b) => b.kind)).toEqual([
      "reply_card",
      "text",
      "reply_card",
    ]);
  });

  it("returns only text when no card was rendered", () => {
    expect(turnBlocks([reply("Hi")], "Hi")).toEqual([{ kind: "text", text: "Hi" }]);
    expect(turnBlocks([], "")).toEqual([]);
  });
});

describe("redactReplyCard", () => {
  const block = replyCardFromToolCall(call("c1"), JSON.stringify(result));
  if (!block) throw new Error("fixture");

  it("passes a clean card through", () => {
    expect(redactReplyCard(block, ["hunter2"])).toBe(block);
  });

  it("degrades a card holding a secret to redacted text", () => {
    expect(redactReplyCard(block, ["ACME"])).toEqual({ kind: "text", text: "[redacted] 12.5" });
  });
});

describe("side chat items", () => {
  it("maps a render_card call to a bot card message, pending without output", () => {
    const done = mapOmnigentItemsToMessages("chat", [call("a"), output("a"), reply("Done")]);
    expect(done.map((m) => m.blocks[0]?.kind)).toEqual(["reply_card", "text"]);
    const pending = mapOmnigentItemsToMessages("chat", [call("a")]);
    expect(pending[0]?.blocks[0]).toMatchObject({ kind: "reply_card", pending: true });
  });

  it("indexes outputs by call id", () => {
    expect(toolOutputsByCallId([output("a"), call("b")]).has("a")).toBe(true);
  });
});
