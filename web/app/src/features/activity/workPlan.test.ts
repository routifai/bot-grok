import type { MessageBlock, ThreadMessage } from "@superchat/contracts";
import { expect, it } from "vitest";
import { drawnOnlyMessageIds, transcriptWork } from "./workPlan";

type Item = { text: string; status: "todo" | "doing" | "done" };

let seq = 0;
function message(id: string, role: "user" | "bot", blocks: MessageBlock[], at = 0): ThreadMessage {
  return {
    id,
    threadId: "conv",
    seq: seq++,
    role,
    blocks,
    createdAt: new Date(Date.UTC(2026, 9, 17, 10, 0, at)).toISOString(),
  };
}
const text = (value: string): MessageBlock => ({ kind: "text", text: value });
const planCard = (items: Item[], id: string | undefined = "plan-1"): MessageBlock => ({
  kind: "reply_card",
  card: "plan",
  ...(id ? { id } : {}),
  data: { items },
  fallback: items.map((item) => item.text).join("\n"),
});

const v1: Item[] = [
  { text: "Read the file", status: "doing" },
  { text: "Build the slides", status: "todo" },
];
const v2: Item[] = [
  { text: "Read the file", status: "done" },
  { text: "Note the cut-off", status: "todo" },
  { text: "Build the slides", status: "doing" },
];

it("draws the newest render of the reply's plan under the reply's text", () => {
  const messages = [
    message("ask", "user", [text("Make the deck")], 0),
    message("reply", "bot", [text("I'll read the file, then build the slides.")], 1),
    message("card-1", "bot", [planCard(v1)], 2),
    message("card-2", "bot", [planCard(v2)], 30),
  ];
  const work = transcriptWork(messages);
  const turn = work.turns.get("reply");
  expect(turn?.plan?.map((step) => [step.text, step.status])).toEqual([
    ["Read the file", "done"],
    ["Note the cut-off", "todo"],
    ["Build the slides", "doing"],
  ]);
  expect(turn?.last).toBe(true);
  expect((turn?.endedAt ?? 0) - (turn?.startedAt ?? 0)).toBe(30_000);
  expect([...work.drawn]).toEqual(["card-1:0", "card-2:0"]);
  // Neither card keeps a row of its own.
  expect([...drawnOnlyMessageIds(messages, work)]).toEqual(["card-1", "card-2"]);
});

it("marks the steps a new render added", () => {
  const work = transcriptWork([
    message("ask", "user", [text("Make the deck")]),
    message("card-1", "bot", [planCard(v1)]),
    message("card-2", "bot", [planCard(v2)]),
    message("reply", "bot", [text("On it.")]),
  ]);
  const plan = work.turns.get("reply")?.plan ?? [];
  expect(plan.filter((step) => step.added).map((step) => step.text)).toEqual(["Note the cut-off"]);
});

it("sits where the Helpers are, and gives each reply its own plan", () => {
  const work = transcriptWork([
    message("ask-1", "user", [text("First")]),
    message("card-a", "bot", [planCard(v1, "plan-a")]),
    message("reply-1", "bot", [
      text("Started."),
      { kind: "helper", helperId: "h1", title: "Build", status: "in_progress" },
    ]),
    message("ask-2", "user", [text("Second")]),
    message("reply-2", "bot", [text("A one-step answer.")]),
  ]);
  expect([...work.turns.keys()]).toEqual(["reply-1"]);
  expect(work.turns.get("reply-1")?.helpers.map((helper) => helper.helperId)).toEqual(["h1"]);
  expect(work.turns.get("reply-1")?.last).toBe(false);
});

it("puts the strip on the plan's own message when the reply has no text yet", () => {
  const messages = [message("ask", "user", [text("Go")]), message("card-1", "bot", [planCard(v1)])];
  const work = transcriptWork(messages);
  expect([...work.turns.keys()]).toEqual(["card-1"]);
  expect(drawnOnlyMessageIds(messages, work).size).toBe(0);
});

it("leaves a reply without a plan or Helper alone, and a plan card that does not parse", () => {
  const work = transcriptWork([
    message("ask", "user", [text("Hi")]),
    message("bad", "bot", [
      { kind: "reply_card", card: "plan", id: "p", data: { items: [] }, fallback: "" },
    ]),
    message("reply", "bot", [text("Hello.")]),
  ]);
  expect(work.turns.size).toBe(0);
  expect(work.drawn.size).toBe(0);
});
