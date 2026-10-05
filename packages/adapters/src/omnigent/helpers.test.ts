import { describe, expect, it } from "vitest";
import { turnBlocks } from "./cards.js";
import { mapOmnigentItemsToMessages } from "./chats.js";
import { helperBlockFromToolCall, isStartHelperCall } from "./helpers.js";

const receipt = (helperId = "conv_helper1", title = "Japan trip") =>
  JSON.stringify({ started: true, helper_id: helperId, title, message: "Helper started." });
const startCall = (callId: string, name = "start_helper") => ({
  id: `i-${callId}`,
  type: "function_call",
  name,
  arguments: JSON.stringify({ task: "Research a Japan trip" }),
  call_id: callId,
});
const startOutput = (callId: string, output: string) => ({
  id: `o-${callId}`,
  type: "function_call_output",
  call_id: callId,
  output,
});
const reply = (text: string) => ({
  id: "m1",
  type: "message",
  role: "assistant",
  created_at: 5,
  content: [{ type: "output_text", text }],
});

describe("helperBlockFromToolCall", () => {
  it("turns the engine's receipt into a Helper block carrying only the id and title", () => {
    expect(helperBlockFromToolCall(receipt())).toEqual({
      kind: "helper",
      helperId: "conv_helper1",
      title: "Japan trip",
    });
  });

  it("shows nothing for a refused, pending or unreadable call", () => {
    expect(helperBlockFromToolCall(undefined)).toBeNull();
    expect(helperBlockFromToolCall("Error: start_helper: no task")).toBeNull();
    expect(helperBlockFromToolCall(JSON.stringify({ started: false }))).toBeNull();
    expect(helperBlockFromToolCall(JSON.stringify({ started: true }))).toBeNull();
  });
});

describe("isStartHelperCall", () => {
  it("accepts the bare tool name and a harness-prefixed one", () => {
    expect(isStartHelperCall(startCall("a"))).toBe(true);
    expect(isStartHelperCall(startCall("a", "mcp__omnigent__start_helper"))).toBe(true);
    expect(isStartHelperCall(startCall("a", "web_search"))).toBe(false);
  });
});

describe("a Helper row follows the hand-off message", () => {
  it("lands after the reply text in a turn, however the items are ordered", () => {
    const items = [startCall("a"), startOutput("a", receipt()), reply("On it.")];
    expect(turnBlocks(items, "On it.")).toEqual([
      { kind: "text", text: "On it." },
      { kind: "helper", helperId: "conv_helper1", title: "Japan trip" },
    ]);
  });

  it("lists each Helper the turn started, in order, and none for a refused call", () => {
    const items = [
      startCall("a"),
      startOutput("a", receipt("conv_a", "First")),
      startCall("b"),
      startOutput("b", "Error: start_helper: busy"),
      startCall("c"),
      startOutput("c", receipt("conv_c", "Second")),
      reply("Two started."),
    ];
    const helpers = turnBlocks(items, "Two started.").filter((b) => b.kind === "helper");
    expect(helpers.map((b) => b.helperId)).toEqual(["conv_a", "conv_c"]);
  });

  it("attaches to the next assistant message in a chat transcript, never a message of its own", () => {
    const messages = mapOmnigentItemsToMessages("chat", [
      startCall("a"),
      startOutput("a", receipt()),
      reply("On it."),
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.blocks).toEqual([
      { kind: "text", text: "On it." },
      { kind: "helper", helperId: "conv_helper1", title: "Japan trip" },
    ]);
  });
});
