import type { MessageBlock, ThreadMessage } from "@superchat/contracts";
import { expect, it } from "vitest";
import { helper } from "./activityTestKit";
import { answeredWhileWorking, deriveWorkStrip, formatClock } from "./workStripState";

const at = (minute: number) => `2026-10-03T11:${String(minute).padStart(2, "0")}:00.000Z`;

function message(
  id: string,
  role: "user" | "bot",
  minute: number,
  blocks: MessageBlock[] = [{ kind: "text", text: id }],
): ThreadMessage {
  return { id, threadId: "conv", seq: 0, role, blocks, createdAt: at(minute) };
}

const startedWork = (minute: number) =>
  message("reply-1", "bot", minute, [
    { kind: "text", text: "I'll write the deck." },
    { kind: "helper", helperId: "h1", title: "Write the deck", status: "in_progress" },
  ]);

it("reads a span as a clock", () => {
  expect(formatClock(0)).toBe("0:00");
  expect(formatClock(41_900)).toBe("0:41");
  expect(formatClock(134_000)).toBe("2:14");
  expect(formatClock(3_729_000)).toBe("1:02:09");
});

it("names the running Helper to focus, else the first listed one", () => {
  const helpers = [
    { helperId: "h1", title: "One" },
    { helperId: "h2", title: "Two" },
  ];
  const working = deriveWorkStrip(
    helpers,
    [helper("h1", { status: "done" }), helper("h2", { status: "in_progress", finishedAt: null })],
    Date.parse(at(30)),
  );
  expect(working.focusId).toBe("sub_agent:h2");
  const settled = deriveWorkStrip(helpers, [helper("h1", { status: "failed" })], 0);
  expect(settled).toMatchObject({ kind: "settled", outcome: "failed", focusId: "sub_agent:h1" });
});

it("marks the reply to a question asked while a Helper ran", () => {
  const messages = [
    message("ask-1", "user", 0),
    startedWork(1),
    message("ask-2", "user", 3),
    message("reply-2", "bot", 4),
  ];
  const running = [helper("h1", { status: "in_progress", startedAt: at(1), finishedAt: null })];
  expect([...answeredWhileWorking(messages, running)]).toEqual(["reply-2"]);
  // The Helper still counts once it is done: the reply came while it ran.
  const done = [helper("h1", { status: "done", startedAt: at(1), finishedAt: at(10) })];
  expect([...answeredWhileWorking(messages, done)]).toEqual(["reply-2"]);
});

it("leaves the hand-back, later replies and replies after the work alone", () => {
  const helpers = [helper("h1", { status: "done", startedAt: at(1), finishedAt: at(5) })];
  // The hand-back follows a runtime wake, not a person's message.
  expect(
    answeredWhileWorking(
      [message("ask-1", "user", 0), startedWork(1), message("hand-back", "bot", 6)],
      helpers,
    ).size,
  ).toBe(0);
  // Asked after the work ended.
  expect(
    answeredWhileWorking(
      [startedWork(1), message("ask-2", "user", 7), message("reply-2", "bot", 8)],
      helpers,
    ).size,
  ).toBe(0);
  // Only the first text reply of the turn, and never a reply that starts work of its own.
  const running = [helper("h1", { status: "in_progress", startedAt: at(1), finishedAt: null })];
  expect([
    ...answeredWhileWorking(
      [
        startedWork(1),
        message("ask-2", "user", 2),
        message("reply-2", "bot", 3),
        message("more", "bot", 4),
        message("ask-3", "user", 5),
        message("new-work", "bot", 6, [
          { kind: "text", text: "Starting that too." },
          { kind: "helper", helperId: "h2", title: "Other", status: "in_progress" },
        ]),
      ],
      running,
    ),
  ]).toEqual(["reply-2"]);
});

it("uses the transcript's status while the feed has not listed the Helper", () => {
  const messages = [startedWork(1), message("ask-2", "user", 2), message("reply-2", "bot", 3)];
  expect([...answeredWhileWorking(messages, undefined)]).toEqual(["reply-2"]);
});
