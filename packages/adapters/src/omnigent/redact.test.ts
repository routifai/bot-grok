import type { Activity, ThreadMessage } from "@aiden/contracts";
import { describe, expect, it } from "vitest";
import { redactActivity, redactMemoryProfile, redactThreadMessages } from "./redact.js";

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

describe("redactActivity", () => {
  const activity: Activity = {
    id: "turn:conv_1:resp_1",
    kind: "turn",
    source: "turn",
    chatId: "conv_1",
    title: "Used sk-live-topsecret to check the account",
    outcome: "Found it with sk-live-topsecret",
    summary: "Found it with sk-live-topsecret",
    status: "done",
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(0).toISOString(),
    date: "2026-10-03",
    steps: [
      {
        itemId: "fc_1",
        title: "Called a tool with sk-live-topsecret",
        createdAt: new Date(0).toISOString(),
        tool: "some_tool",
        detail: {
          arguments: { token: "sk-live-topsecret", nested: { note: "sk-live-topsecret" } },
          output: ["sk-live-topsecret", 42, true],
        },
      },
    ],
  };

  it("redacts title, outcome, step title, and every string nested in step detail", () => {
    const redacted = redactActivity(activity, SECRETS);
    expect(redacted.title).toBe("Used [redacted] to check the account");
    expect(redacted.outcome).toBe("Found it with [redacted]");
    expect(redacted.summary).toBe("Found it with [redacted]");
    expect(redacted.steps?.[0]?.title).toBe("Called a tool with [redacted]");
    expect(redacted.steps?.[0]?.detail).toEqual({
      arguments: { token: "[redacted]", nested: { note: "[redacted]" } },
      output: ["[redacted]", 42, true],
    });
  });

  it("leaves numbers/booleans in detail untouched and a null outcome as null", () => {
    const withNullOutcome: Activity = { ...activity, outcome: null };
    const redacted = redactActivity(withNullOutcome, SECRETS);
    expect(redacted.outcome).toBeNull();
    expect(redacted.steps?.[0]?.detail?.output).toEqual(["[redacted]", 42, true]);
  });

  it("is a no-op with no secrets configured", () => {
    expect(redactActivity(activity, [])).toBe(activity);
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
