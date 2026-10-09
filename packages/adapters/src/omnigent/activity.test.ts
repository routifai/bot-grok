import { describe, expect, it } from "vitest";
import { mapActivity, mapActivityStep, plainFailureOutcome } from "./activities.js";

describe("mapActivityStep", () => {
  it("maps snake_case fields to camelCase and defaults a missing tool/detail", () => {
    expect(
      mapActivityStep({ item_id: "fc_1", title: "Searched memory for 'Q4'", created_at: 1000 }),
    ).toEqual({
      itemId: "fc_1",
      title: "Searched memory for 'Q4'",
      createdAt: new Date(1000 * 1000).toISOString(),
      tool: null,
      detail: undefined,
    });
  });

  it("carries tool and detail through when present", () => {
    const mapped = mapActivityStep({
      item_id: "fc_2",
      title: "Used memory_search",
      created_at: 2000,
      tool: "memory_search",
      detail: { query: "Q4" },
    });
    expect(mapped.tool).toBe("memory_search");
    expect(mapped.detail).toEqual({ query: "Q4" });
  });
});

describe("mapActivity", () => {
  it("maps a turn Activity, defaulting outcome/finishedAt to null and steps to undefined", () => {
    expect(
      mapActivity({
        id: "turn:conv_abc:resp_xyz",
        kind: "turn",
        source: "side_chat",
        chat_id: "conv_abc",
        title: "Check Q4 totals",
        outcome: null,
        summary: null,
        status: "in_progress",
        started_at: 1000,
        finished_at: null,
        date: "2026-10-03",
      }),
    ).toEqual({
      id: "turn:conv_abc:resp_xyz",
      kind: "turn",
      chatId: "conv_abc",
      source: "side_chat",
      title: "Check Q4 totals",
      outcome: null,
      summary: null,
      status: "in_progress",
      startedAt: new Date(1000 * 1000).toISOString(),
      finishedAt: null,
      date: "2026-10-03",
      parentChatId: null,
      steps: undefined,
    });
  });

  it("maps a finished sub_agent Activity with its Steps", () => {
    const mapped = mapActivity({
      id: "sub_agent:conv_child",
      kind: "sub_agent",
      source: "scheduled",
      chat_id: "conv_child",
      title: "Research Q4 totals",
      outcome: "Found the figures in the Q4 report.",
      summary: "Found the figures in the Q4 report.",
      status: "done",
      started_at: 1000,
      finished_at: 1050,
      date: "2026-10-03",
      steps: [
        {
          item_id: "fc_1",
          title: "Searched memory for 'Q4'",
          created_at: 1010,
          tool: "memory_search",
        },
      ],
    });
    expect(mapped.status).toBe("done");
    expect(mapped.source).toBe("scheduled");
    expect(mapped.summary).toBe("Found the figures in the Q4 report.");
    expect(mapped.outcome).toBe("Found the figures in the Q4 report.");
    expect(mapped.finishedAt).toBe(new Date(1050 * 1000).toISOString());
    expect(mapped.steps).toEqual([
      {
        itemId: "fc_1",
        title: "Searched memory for 'Q4'",
        createdAt: new Date(1010 * 1000).toISOString(),
        tool: "memory_search",
        detail: undefined,
      },
    ]);
  });
});

describe("plainFailureOutcome", () => {
  it("names a known failure in plain words and never leaks internals", () => {
    expect(
      plainFailureOutcome(
        "inner executor error: There's an issue with the selected model (a-model). It may not exist or you may not have access to it.",
      ),
    ).toBe("The model isn't available.");
    expect(plainFailureOutcome("API Error: 529 overloaded_error")).toBe("The model was busy.");
    expect(
      plainFailureOutcome(
        "Claude SDK connect failed: exit code 1\nCLI stderr: /Users/x/.venv/bin/python",
      ),
    ).toBe("Couldn't get started.");
    expect(plainFailureOutcome('Traceback (most recent call last):\n  File "/srv/a.py"')).toBe(
      "Could not complete the task",
    );
  });

  it("keeps a short plain reason and the generic line, and says nothing for none", () => {
    expect(plainFailureOutcome("The spreadsheet had no Q4 tab")).toBe(
      "The spreadsheet had no Q4 tab",
    );
    expect(plainFailureOutcome("Could not complete the task")).toBe("Could not complete the task");
    expect(plainFailureOutcome(null)).toBeNull();
  });

  it("only rewrites failed Activities", () => {
    const base = {
      id: "turn:c:r",
      kind: "turn" as const,
      source: "turn" as const,
      chat_id: "c",
      title: "t",
      summary: null,
      started_at: 1,
      finished_at: 2,
      date: "2026-10-04",
    };
    expect(mapActivity({ ...base, status: "done", outcome: "API Error: 529" }).outcome).toBe(
      "API Error: 529",
    );
    expect(
      mapActivity({ ...base, status: "failed", outcome: "API Error: 529 overloaded_error" }),
    ).toMatchObject({
      outcome: "The model was busy.",
      summary: "The model was busy.",
    });
  });
});

describe("mapActivity nesting", () => {
  const helper = {
    id: "sub_agent:conv_part",
    kind: "sub_agent" as const,
    source: "background" as const,
    chat_id: "conv_part",
    title: "Flights",
    outcome: null,
    summary: null,
    status: "in_progress" as const,
    started_at: 1000,
    finished_at: null,
    date: "2026-10-03",
  };

  it("carries the chat that started a Helper, so a part nests under its coordinator", () => {
    expect(mapActivity({ ...helper, parent_chat_id: "conv_lead" }).parentChatId).toBe("conv_lead");
  });

  it("reads an engine that does not say as no parent", () => {
    expect(mapActivity(helper).parentChatId).toBeNull();
  });
});
