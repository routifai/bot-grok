import { describe, expect, it } from "vitest";
import {
  fileCardFromArtifactSave,
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
  it("keeps the artifact id of a file card a Helper's result named", () => {
    const file = {
      card: "file",
      data: { name: "report.html", artifactId: "a1b2", version: 2 },
      fallback: "Saved report.html",
    };
    expect(
      replyCardFromToolCall(call("c1"), JSON.stringify({ type: "card", ...file })),
    ).toMatchObject({ card: "file", data: file.data });
  });

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

  it("makes one Helper row and one card when the turn repeats a tool call", () => {
    const receipt = { started: true, helper_id: "h1", title: "Japan trip plan" };
    const items = [
      call("s", "start_helper"),
      output("s", receipt),
      call("s", "start_helper"),
      output("s", receipt),
      call("a"),
      output("a"),
      call("a"),
      reply("On it."),
    ];
    expect(turnBlocks(items, "On it.").map((b) => b.kind)).toEqual([
      "reply_card",
      "text",
      "helper",
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

describe("secure entry cards", () => {
  const ask = { type: "function_call", call_id: "v1", name: "vault_request_secret" };
  const result = JSON.stringify({
    secure_entry: { id: "r1", name: "acme", site: "https://acme.test", reason: "to sign in" },
    message: "A secure card is shown.",
  });

  it("turns a finished vault_request_secret into a secure_entry card with only the request id", () => {
    const blocks = turnBlocks(
      [ask, { type: "function_call_output", call_id: "v1", output: result }],
      "",
    );
    expect(blocks).toEqual([
      expect.objectContaining({
        kind: "reply_card",
        card: "secure_entry",
        data: { requestId: "r1", name: "acme", site: "https://acme.test", reason: "to sign in" },
      }),
    ]);
  });

  it("shows nothing for a pending or failed request, and also in side-chat history", () => {
    expect(turnBlocks([ask], "")).toEqual([]);
    const failed = { type: "function_call_output", call_id: "v1", output: '{"error":"off"}' };
    expect(turnBlocks([ask, failed], "")).toEqual([]);
    const done = { type: "function_call_output", call_id: "v1", output: result };
    const messages = mapOmnigentItemsToMessages("chat", [
      { id: "i1", created_at: 1, ...ask },
      { id: "i2", created_at: 2, ...done },
    ] as never);
    expect(messages[0]?.blocks[0]).toMatchObject({ kind: "reply_card", card: "secure_entry" });
  });
});

describe("artifact_save -> file card", () => {
  const saved = {
    type: "artifact",
    id: "a".repeat(32),
    name: "report.html",
    title: null,
    kind: "html",
    size: 2048,
    version: 2,
    versions: 2,
  };
  const saveCall = { type: "function_call", name: "mcp__omnigent__artifact_save", call_id: "s1" };

  it("becomes a file card that opens the saved artifact", () => {
    const done = { type: "function_call_output", call_id: "s1", output: JSON.stringify(saved) };
    const [block] = turnBlocks([saveCall, done], "");
    expect(block).toMatchObject({
      kind: "reply_card",
      card: "file",
      data: { name: "report.html", artifactId: saved.id, kind: "html", size: 2048, version: 2 },
    });
    expect((block as { fallback: string }).fallback).toContain("version 2");
  });

  it("shows nothing for a pending or failed save", () => {
    expect(turnBlocks([saveCall], "")).toEqual([]);
    expect(fileCardFromArtifactSave('{"error":"file not found: x.html"}')).toBeNull();
    expect(fileCardFromArtifactSave(undefined)).toBeNull();
  });
});
