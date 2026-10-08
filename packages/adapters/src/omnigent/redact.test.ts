import type { ThreadMessage } from "@nova/contracts";
import { describe, expect, it } from "vitest";
import { redactMemoryProfile, redactThreadMessages } from "./redact.js";

const SECRETS = ["sk-live-topsecret"];

describe("redactThreadMessages", () => {
  const message: ThreadMessage = {
    id: "msg_1",
    threadId: "conv_1",
    seq: 0,
    role: "bot",
    blocks: [{ kind: "text", text: "the key is sk-live-topsecret, use it" }],
    createdAt: new Date(0).toISOString(),
  };

  it("redacts a secret inside a text block", () => {
    const [redacted] = redactThreadMessages([message], SECRETS);
    expect(redacted?.blocks).toEqual([{ kind: "text", text: "the key is [redacted], use it" }]);
  });

  it("redacts a secret inside a Helper row's title", () => {
    const withHelper: ThreadMessage = {
      ...message,
      blocks: [{ kind: "helper", helperId: "conv_h", title: "Use sk-live-topsecret" }],
    };
    const [redacted] = redactThreadMessages([withHelper], SECRETS);
    expect(redacted?.blocks).toEqual([
      { kind: "helper", helperId: "conv_h", title: "Use [redacted]" },
    ]);
  });

  it("is a no-op with no secrets configured", () => {
    const messages = [message];
    expect(redactThreadMessages(messages, [])).toBe(messages);
  });
});

describe("redactMemoryProfile", () => {
  it("redacts a secret inside the profile text", () => {
    expect(redactMemoryProfile("remembers sk-live-topsecret", SECRETS)).toBe(
      "remembers [redacted]",
    );
  });

  it("passes null through unchanged", () => {
    expect(redactMemoryProfile(null, SECRETS)).toBeNull();
  });

  it("is a no-op with no secrets configured", () => {
    expect(redactMemoryProfile("sk-live-topsecret", [])).toBe("sk-live-topsecret");
  });
});
