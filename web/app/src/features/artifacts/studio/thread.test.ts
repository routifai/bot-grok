// The studio thread (ADR 0024): the studio session's transcript merged with the file's versions.

import type { ArtifactVersion, ThreadMessage } from "@superchat/contracts";
import { describe, expect, it } from "vitest";
import { buildElementAsk } from "../editor/html-ask";
import { editedElement, studioThread, threadSummary, versionOrigin } from "./thread";

const STUDIO = "studio-1";
const CONVERSATION = "conv-1";
const at = (seconds: number) => new Date(seconds * 1000).toISOString();

const message = (id: string, role: "user" | "bot", text: string, t: number): ThreadMessage => ({
  id,
  threadId: STUDIO,
  seq: t,
  role,
  blocks: [{ kind: "text", text }],
  createdAt: at(t),
});

const version = (n: number, t: number, extra: Partial<ArtifactVersion> = {}): ArtifactVersion => ({
  id: `v${n}`,
  version: n,
  name: "mock_markets.deck.html",
  createdAt: at(t),
  origin: "ai",
  chatId: CONVERSATION,
  itemId: null,
  ...extra,
});

describe("studioThread", () => {
  const versions = [
    version(6, 50),
    version(5, 42, { origin: "manual", editSummary: "slide 3 (region-chart): duplicated" }),
    version(4, 41, { origin: "manual", editSummary: "slide 3 title color #111→#c33" }),
    version(3, 40, { origin: "manual", editSummary: "slide 3 title font-size 26px→32px" }),
    version(2, 20, { chatId: STUDIO, itemId: "m1", fromStudio: true }),
    version(1, 0),
  ];
  const messages = [
    message("m1", "user", "Make this a bar chart, biggest first.", 10),
    message("a1", "bot", "Done: slide 3 is now a bar chart.", 30),
  ];

  it("merges the chat and the versions by time, a chat save after its reply", () => {
    const rows = studioThread(messages, versions, STUDIO);
    expect(rows.map((row) => (row.kind === "version" ? `v${row.version}` : row.kind))).toEqual([
      "v1",
      "me",
      "ai",
      "v2",
      "hand",
      "v4",
      "hand",
      "v5",
      "v6",
    ]);
  });

  it("names each version's origin in the five studio words", () => {
    const origins = studioThread(messages, versions, STUDIO).flatMap((row) =>
      row.kind === "version" ? [`v${row.version}:${row.origin}`] : [],
    );
    expect(origins).toEqual(["v1:superchat", "v2:chat", "v4:you", "v5:you", "v6:superchat"]);
    expect(versionOrigin(version(7, 60, { origin: "restore" }), STUDIO)).toBe("restored");
    expect(versionOrigin(version(8, 61, { origin: "update" }), STUDIO)).toBe("updated");
  });

  it("folds consecutive hand edits to one element into one row", () => {
    const hands = studioThread(messages, versions, STUDIO).filter((row) => row.kind === "hand");
    expect(hands).toMatchObject([
      { element: "slide 3 title", count: 2, from: 3, to: 4, versionIds: ["v3", "v4"] },
      { element: "slide 3 (region-chart)", count: 1, from: 5, to: 5 },
    ]);
    expect(threadSummary(studioThread(messages, versions, STUDIO))).toEqual({
      edits: 4,
      first: 1,
      last: 6,
    });
  });

  it("shows a request's element chip instead of its request block", () => {
    const { block } = buildElementAsk({
      artifactId: "v2",
      name: "mock_markets.deck.html",
      version: 2,
      elements: [{ id: "region-chart", label: "Chart", slide: 3, text: null, style: {} }],
      noun: (n) => `${n} elements`,
    });
    const asked = message("m2", "user", `${block}\n\nShow the share next to each bar.`, 60);
    const [row] = studioThread([asked], [], STUDIO);
    expect(row).toMatchObject({
      kind: "me",
      chip: "Slide 3 · region-chart",
      text: "Show the share next to each bar.",
    });
  });

  it("reads the element from a hand edit's summary", () => {
    expect(editedElement("slide 2 (cover) font-size 20px→24px")).toBe("slide 2 (cover)");
    expect(editedElement('add-button text "Add" → "Save"')).toBe("add-button");
    expect(editedElement(null)).toBeNull();
  });
});
