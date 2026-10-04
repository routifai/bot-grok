import { describe, expect, it } from "vitest";
import { stepDetailText } from "./stepDetail";

describe("stepDetailText", () => {
  it("shows a call's JSON args pretty-printed and the result's text", () => {
    const text = stepDetailText({
      call: { type: "tool_call", name: "sys_session_send", args: '{"agent":"researcher"}' },
      result: { type: "tool_result", content: "launched" },
    });
    expect(text.input).toBe('{\n  "agent": "researcher"\n}');
    expect(text.output).toBe("launched");
  });

  it("never renders an object as [object Object]", () => {
    const text = stepDetailText({ call: { name: "x" }, result: { nested: { a: 1 } } });
    expect(text.input).toContain('"name": "x"');
    expect(text.output).toContain('"a": 1');
  });

  it("formats an unrecognized detail shape as JSON", () => {
    expect(stepDetailText({ query: "q4" }).input).toBe('{\n  "query": "q4"\n}');
  });

  it("clips very long output", () => {
    const text = stepDetailText({ result: { content: "x".repeat(5000) } });
    expect(text.output?.length).toBe(4001);
  });
});
