import type { MessageBlock, ReplyCardBlock, ThreadMessage } from "@superchat/contracts";
import { expect, it } from "vitest";
import { drawnOnlyMessageIds, markChanges, outcomeOf, transcriptWork } from "./workPlan";

type Item = { text: string; status: "todo" | "doing" | "done" };

// The engine's order (engine/omnigent/superchat/transcript/blocks.py): each card is a message of
// its own, in call order, and a turn keeps one text, its last, after its cards; the Helpers it
// started ride on that text.
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
const helperBlock = (id: string): MessageBlock => ({
  kind: "helper",
  helperId: id,
  title: `Helper ${id}`,
  status: "in_progress",
});
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
const steps = (plan: { text: string; status: string }[] | null | undefined) =>
  plan?.map((step) => [step.text, step.status]);

it("draws the newest render of the reply's plan in one strip, under the reply", () => {
  const messages = [
    message("ask", "user", [text("Make the deck")], 0),
    message("card-1", "bot", [planCard(v1)], 2),
    message("card-2", "bot", [planCard(v2)], 30),
    message("reply", "bot", [text("The deck is ready.")], 31),
  ];
  const work = transcriptWork(messages);
  expect([...work.turns.keys()]).toEqual(["reply"]);
  const turn = work.turns.get("reply");
  expect(steps(turn?.plan)).toEqual([
    ["Read the file", "done"],
    ["Note the cut-off", "todo"],
    ["Build the slides", "doing"],
  ]);
  expect(turn?.last).toBe(true);
  expect(turn?.outcome).toBe("done");
  expect((turn?.endedAt ?? 0) - (turn?.startedAt ?? 0)).toBe(31_000);
  expect(work.runningSince).toBe(turn?.startedAt);
  expect([...work.drawn]).toEqual(["card-1:0", "card-2:0"]);
  // The plan cards leave no rows; the reply keeps its own.
  expect([...drawnOnlyMessageIds(messages, work)]).toEqual(["card-1", "card-2"]);
});

it("sits where the work first showed while the reply is written, and under its text once it lands", () => {
  const ask = message("ask", "user", [text("Make the deck")], 0);
  const card1 = message("card-1", "bot", [planCard(v1)], 2);
  const card2 = message("card-2", "bot", [planCard(v2)], 30);
  const streaming = transcriptWork([ask, card1]);
  const more = transcriptWork([ask, card1, card2]);
  const answered = transcriptWork([
    ask,
    card1,
    card2,
    message("reply", "bot", [text("Done.")], 40),
  ]);
  for (const work of [streaming, more]) expect([...work.turns.keys()]).toEqual(["card-1"]);
  expect([...answered.turns.keys()]).toEqual(["reply"]);
});

it("sits where the Helpers are, and gives each reply its own plan", () => {
  const work = transcriptWork([
    message("ask-1", "user", [text("First")]),
    message("card-a", "bot", [planCard(v1, "plan-a")]),
    message("reply-1", "bot", [text("Started."), helperBlock("h1")]),
    message("ask-2", "user", [text("Second")]),
    message("reply-2", "bot", [text("A one-step answer.")]),
  ]);
  expect([...work.turns.keys()]).toEqual(["reply-1"]);
  expect(work.turns.get("reply-1")?.helpers.map((helper) => helper.helperId)).toEqual(["h1"]);
  expect(work.turns.get("reply-1")?.last).toBe(false);
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

it("keeps one strip when the person's message is steered into the running reply", () => {
  const messages = [
    message("ask", "user", [text("Make the deck")], 0),
    message("card-1", "bot", [planCard(v1)], 2),
    message("steer", "user", [text("Use the blue theme")], 10),
    message("card-2", "bot", [planCard(v2)], 20),
    message("reply", "bot", [text("Building it in blue."), helperBlock("h1")], 21),
  ];
  const work = transcriptWork(messages);
  expect([...work.turns.keys()]).toEqual(["reply"]);
  const turn = work.turns.get("reply");
  expect(steps(turn?.plan)?.[2]).toEqual(["Build the slides", "doing"]);
  expect(turn?.helpers.map((helper) => helper.helperId)).toEqual(["h1"]);
  expect(turn?.startedAt).toBe(Date.parse(messages[0]?.createdAt ?? ""));
  expect(turn?.last).toBe(true);
  // The strip draws the plan and the Helpers.
  expect([...work.drawn]).toEqual(["card-1:0", "card-2:0", "reply:1"]);
  expect([...drawnOnlyMessageIds(messages, work)]).toEqual(["card-1", "card-2"]);
});

it("leaves no row for a message holding only the Helpers its reply's strip draws", () => {
  const messages = [
    message("ask", "user", [text("Research it")], 0),
    message("started", "bot", [helperBlock("h1")], 1),
    message("reply", "bot", [text("A Helper is on it.")], 2),
  ];
  const work = transcriptWork(messages);
  expect([...work.turns.keys()]).toEqual(["reply"]);
  expect([...drawnOnlyMessageIds(messages, work)]).toEqual(["started"]);
});

it("leaves a later reply's strip alone when a Helper's wake narration arrives", () => {
  const messages = [
    message("ask-1", "user", [text("Write the report")], 0),
    message("reply-1", "bot", [text("A Helper is on it."), helperBlock("h1")], 1),
    message("ask-2", "user", [text("And plan the offsite")], 10),
    message("card-2", "bot", [planCard(v1, "plan-2")], 11),
    message("reply-2", "bot", [text("Here is the offsite plan.")], 12),
    // The runtime's notice that h1 finished is dropped; its narration follows.
    message("wake", "bot", [text("The report is done.")], 60),
  ];
  const work = transcriptWork(messages);
  const second = work.turns.get("reply-2");
  expect(second?.last).toBe(false);
  expect(second?.endedAt).toBe(Date.parse(messages[4]?.createdAt ?? ""));
  expect(work.turns.get("reply-1")?.last).toBe(false);
  expect(work.runningSince).toBe(Date.parse(messages[5]?.createdAt ?? ""));
});

it("gives the wake turn to the reply whose plan it carries on", () => {
  const work = transcriptWork([
    message("ask-1", "user", [text("Make the deck")], 0),
    message("card-1", "bot", [planCard(v1)], 1),
    message("reply-1", "bot", [text("A Helper builds it."), helperBlock("h1")], 2),
    message("ask-2", "user", [text("What time is it?")], 10),
    message("reply-2", "bot", [text("Ten.")], 11),
    message("card-3", "bot", [planCard(v2)], 60),
    message("wake", "bot", [text("Read it; building now.")], 61),
  ]);
  const turn = work.turns.get("reply-1");
  expect(steps(turn?.plan)?.[0]).toEqual(["Read the file", "done"]);
  expect(turn?.last).toBe(true);
  expect(turn?.endedAt).toBe(Date.UTC(2026, 9, 17, 10, 1, 1));
});

it("reads how the reply ended", () => {
  const outcome = (...replies: ThreadMessage[]) =>
    [...transcriptWork([message("ask", "user", [text("Go")]), ...replies]).turns.values()][0]
      ?.outcome;
  const card = () => message(`card-${seq}`, "bot", [planCard(v1)]);
  expect(outcome(card(), message("r", "bot", [text("Done.")]))).toBe("done");
  // A plan, a Helper or a file is a reply too: no text is not a Stop (the work state says that).
  expect(outcome(card())).toBe("done");
  expect(outcome(message("h", "bot", [helperBlock("h1")]))).toBe("done");
  expect(
    outcomeOf([
      message("f", "bot", [
        { kind: "file", artifactId: "a1", name: "deck.html", mimeType: "text/html", size: 1 },
      ]),
    ]),
  ).toBe("done");
  // Only a reply that left nothing but live status was cut short.
  expect(outcomeOf([])).toBe("cancelled");
  expect(outcomeOf([message("p", "bot", [{ kind: "progress", text: "Reading…" }])])).toBe(
    "cancelled",
  );
  expect(outcome(card(), message("e", "bot", [{ kind: "error", code: "overloaded" }]))).toBe(
    "failed",
  );
  expect(
    outcome(
      card(),
      message("q", "bot", [
        { kind: "reply_card", card: "ask", data: { question: "Which?" }, fallback: "Which?" },
      ]),
      message("r", "bot", [text("Which theme do you want?")]),
    ),
  ).toBe("asked");
});

it("marks a step added where it is new and changed where it was reworded", () => {
  const plan = (...texts: string[]) =>
    texts.map((value) => ({ text: value, status: "todo" as const, added: false }));
  const marks = (next: string[], previous: string[]) =>
    markChanges(plan(...next), plan(...previous)).map((step) =>
      step.added ? "added" : step.changed ? "changed" : "same",
    );
  expect(marks(["A", "X", "B"], ["A", "B"])).toEqual(["same", "added", "same"]);
  expect(marks(["A", "B2", "C"], ["A", "B", "C"])).toEqual(["same", "changed", "same"]);
  // A repeated step is new, however its words match an earlier one.
  expect(marks(["A", "A", "B"], ["A", "B"])).toEqual(["same", "added", "same"]);
  expect(marks(["A", "C"], ["A", "B", "C"])).toEqual(["same", "same"]);
  expect(marks(["A", "B", "D"], ["A", "B"])).toEqual(["same", "same", "added"]);
  // Unchanged since the previous render: nothing to mark.
  expect(marks(["A", "B2"], ["A", "B2"])).toEqual(["same", "same"]);

  const work = transcriptWork([
    message("ask", "user", [text("Make the deck")]),
    message("card-1", "bot", [planCard(v1)]),
    message("card-2", "bot", [planCard(v2)]),
    message("reply", "bot", [text("On it.")]),
  ]);
  const newest = work.turns.get("reply")?.plan ?? [];
  expect(newest.filter((step) => step.added).map((step) => step.text)).toEqual([
    "Note the cut-off",
  ]);
});

it("reads each step's engine state and present tense, and names the plan card (ADR 0027)", () => {
  const card: MessageBlock = {
    kind: "reply_card",
    card: "plan",
    id: "plan-9",
    data: {
      items: [
        { text: "Brief", status: "done", state: "done" },
        { text: "Build", status: "done", state: "claimed", active: "Building" },
        { text: "Check", status: "todo", state: "not_checked" },
      ],
    },
    fallback: "Brief\nBuild\nCheck",
  };
  const work = transcriptWork([
    message("ask", "user", [text("Make the deck")], 0),
    message("card", "bot", [card], 2),
    message("reply", "bot", [text("Here it is.")], 3),
  ]);
  const turn = work.turns.get("reply");
  expect(turn?.planId).toBe("plan-9");
  expect(turn?.plan).toEqual([
    { text: "Brief", status: "done", engine: true, added: false },
    { text: "Build", status: "claimed", active: "Building", engine: true, added: false },
    { text: "Check", status: "not_checked", engine: true, added: false },
  ]);
  // A plan card without an id is named by its block.
  const plain = transcriptWork([
    message("ask2", "user", [text("Again")], 0),
    message("card2", "bot", [{ ...(planCard(v1) as ReplyCardBlock), id: undefined }], 1),
  ]);
  expect([...plain.turns.values()][0]?.planId).toBe("card2:0");
});

it("takes the engine's fold, the reply's Activity and the files its turn saved", () => {
  const card: MessageBlock = { ...(planCard(v2) as ReplyCardBlock), fold: 1 };
  const file: MessageBlock = {
    kind: "reply_card",
    card: "file",
    id: "artifact:a1",
    data: { name: "rbc.deck.html", artifactId: "a1" },
    fallback: "Saved",
  };
  const work = transcriptWork([
    message("ask", "user", [text("Make the deck")], 0),
    { ...message("card", "bot", [card], 2), activityId: "turn:conv:r1" },
    message("saved", "bot", [file], 3),
    { ...message("reply", "bot", [text("Here it is.")], 4), activityId: "turn:conv:r1" },
  ]);
  const turn = work.turns.get("reply");
  expect(turn?.fold).toBe(1);
  expect(turn?.activityId).toBe("turn:conv:r1");
  expect(turn?.files).toEqual(["a1"]);
  const none = transcriptWork([
    message("ask2", "user", [text("Again")], 0),
    message("card2", "bot", [planCard(v1)], 1),
  ]);
  const plain = [...none.turns.values()][0];
  expect([plain?.fold, plain?.activityId, plain?.files]).toEqual([0, null, []]);
});
