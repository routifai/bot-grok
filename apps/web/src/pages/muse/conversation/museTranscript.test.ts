import type { ThreadMessage, ThreadMessagePage } from "@nova/contracts";
import { describe, expect, it } from "vitest";
import {
  conversationMessages,
  mergeNewestTranscriptPage,
  pendingUserMessages,
  quotedMessageText,
} from "./museTranscript";

const message = (
  id: string,
  createdAt: string,
  role: ThreadMessage["role"] = "bot",
): ThreadMessage => ({
  id,
  threadId: "t",
  seq: 0,
  role,
  blocks: [{ kind: "text", text: id }],
  createdAt,
});
const page = (messages: ThreadMessage[], olderItemCursor: string | null): ThreadMessagePage => ({
  threadId: "t",
  messages,
  olderCursor: null,
  olderItemCursor,
});

describe("mergeNewestTranscriptPage", () => {
  const a = message("a", "2026-10-01T10:00:00Z");
  const b = message("b", "2026-10-01T10:01:00Z");
  const c = message("c", "2026-10-01T10:02:00Z");

  it("starts from the page when nothing is loaded", () => {
    expect(mergeNewestTranscriptPage(null, page([b, c], "b"))).toEqual({
      threadId: "t",
      messages: [b, c],
      olderCursor: "b",
    });
  });

  it("keeps older pages that were loaded and their cursor", () => {
    const merged = mergeNewestTranscriptPage(
      { messages: [a, b], olderCursor: null },
      page([b, c], "b"),
    );
    expect(merged.messages.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(merged.olderCursor).toBeNull();
  });

  it("starts over when the new page does not reach back to what was loaded", () => {
    const merged = mergeNewestTranscriptPage(
      { messages: [a], olderCursor: null },
      page([b, c], "b"),
    );
    expect(merged.messages.map((m) => m.id)).toEqual(["b", "c"]);
    expect(merged.olderCursor).toBe("b");
  });
});

describe("pendingUserMessages", () => {
  const sent = message("n1", "2026-10-01T10:05:00.700Z", "user");

  it("shows an accepted message the transcript has not caught up with", () => {
    const transcript = [message("e1", "2026-10-01T10:04:30Z")];
    expect(pendingUserMessages([sent], transcript)).toEqual([sent]);
  });

  it("drops it once the transcript has anything from its second on", () => {
    const transcript = [message("e1", "2026-10-01T10:05:00Z", "user")];
    expect(pendingUserMessages([sent], transcript)).toEqual([]);
  });

  it("ignores replies and everything older than the transcript", () => {
    const reply = message("n2", "2026-10-01T10:06:00Z", "bot");
    const transcript = [message("e1", "2026-10-01T10:05:30Z")];
    expect(pendingUserMessages([sent, reply], transcript)).toEqual([]);
  });

  it("keeps a message sent while the Muse works, though its replies landed after the send", () => {
    // The person's first message, then tool work and a reply stamped after the second send.
    const transcript = [
      message("e0", "2026-10-01T10:04:00Z", "user"),
      message("e1", "2026-10-01T10:05:03Z"),
      message("e2", "2026-10-01T10:05:09Z"),
    ];
    expect(pendingUserMessages([sent], transcript)).toEqual([sent]);
    // Once the engine records it, it is in the transcript and no longer pending.
    const recorded = [...transcript, message("e3", "2026-10-01T10:05:10Z", "user")];
    expect(pendingUserMessages([sent], recorded)).toEqual([]);
  });

  it("shows every accepted message when the transcript is empty", () => {
    expect(pendingUserMessages([sent], [])).toEqual([sent]);
  });
});

describe("quotedMessageText", () => {
  it("puts the quote above the reply as a blockquote, line by line", () => {
    expect(quotedMessageText("one\ntwo", "Yes")).toBe("> one\n> two\n\nYes");
  });

  it("sends just the quote when nothing else was typed", () => {
    expect(quotedMessageText("one", "")).toBe("> one");
  });
});

describe("conversationMessages", () => {
  const withBlocks = (
    id: string,
    createdAt: string,
    role: ThreadMessage["role"],
    blocks: ThreadMessage["blocks"],
  ): ThreadMessage => ({ id, threadId: "t", seq: 0, role, blocks, createdAt });
  const e1 = message("e1", "2026-10-01T10:00:00Z", "user");
  const e2 = message("e2", "2026-10-01T10:02:00Z");
  const draft = withBlocks("n-draft", "2026-10-01T10:01:00.400Z", "bot", [
    { kind: "meta", text: "Created routine" },
  ]);

  it("layers Nova's own rows in among the engine's, by time", () => {
    expect(conversationMessages([e1, e2], [draft]).map((m) => m.id)).toEqual([
      "e1",
      "n-draft",
      "e2",
    ]);
  });

  it("leaves out Nova's copies of messages and replies, which the transcript supplies", () => {
    const copyOfUser = message("n-user", "2026-10-01T10:00:00.200Z", "user");
    const copyOfReply = withBlocks("n-reply", "2026-10-01T10:02:00.100Z", "bot", [
      { kind: "text", text: "hi" },
    ]);
    expect(conversationMessages([e1, e2], [copyOfUser, copyOfReply]).map((m) => m.id)).toEqual([
      "e1",
      "e2",
    ]);
  });

  it("holds back Nova rows older than the loaded window, and keeps a not-yet-recorded send once", () => {
    const old = withBlocks("n-old", "2026-09-01T10:00:00Z", "bot", [{ kind: "meta", text: "old" }]);
    const sent = message("n-sent", "2026-10-01T10:05:00Z", "user");
    const merged = conversationMessages([e1, e2], [old, sent, sent]);
    expect(merged.map((m) => m.id)).toEqual(["e1", "e2", "n-sent"]);
  });

  it("shows every Nova-owned row while the engine has nothing yet", () => {
    expect(conversationMessages([], [draft]).map((m) => m.id)).toEqual(["n-draft"]);
  });
});

describe("a message sent while the Muse works", () => {
  it("shows once while pending, then once as the engine echo, with unique ids throughout", () => {
    const first = message("e0", "2026-10-01T10:04:00Z", "user");
    const reply = message("e1", "2026-10-01T10:05:03Z");
    const sent = message("n-sent", "2026-10-01T10:05:05Z", "user");
    const ids = (messages: ThreadMessage[]) => messages.map((m) => m.id);
    const unique = (messages: ThreadMessage[]) => new Set(ids(messages)).size === messages.length;

    // The send is accepted; the Muse's own reply stamped before it does not hide it.
    const pending = conversationMessages([first, reply], [sent, sent]);
    expect(ids(pending)).toEqual(["e0", "e1", "n-sent"]);
    expect(unique(pending)).toBe(true);

    // The engine records it (steered into the turn, or queued) and says how.
    const echo = message("e2", "2026-10-01T10:05:06Z", "user");
    const settled = conversationMessages([first, reply, echo], [sent]);
    expect(ids(settled)).toEqual(["e0", "e1", "e2"]);
    expect(unique(settled)).toBe(true);

    // A queued echo stamped in the same second as the send also replaces the pending copy.
    const queued = {
      ...message("e3", "2026-10-01T10:05:05Z", "user"),
      delivered: "queued" as const,
    };
    expect(ids(conversationMessages([first, reply, queued], [sent]))).toEqual(["e0", "e1", "e3"]);
  });
});
