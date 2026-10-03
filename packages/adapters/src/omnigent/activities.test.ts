import { describe, expect, it } from "vitest";
import { mapActivity, mapActivityStep } from "./activities.js";

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
        chat_id: "conv_abc",
        title: "Checked Q4 totals",
        outcome: null,
        status: "in_progress",
        started_at: 1000,
        finished_at: null,
        date: "2026-10-03",
      }),
    ).toEqual({
      id: "turn:conv_abc:resp_xyz",
      kind: "turn",
      chatId: "conv_abc",
      title: "Checked Q4 totals",
      outcome: null,
      status: "in_progress",
      startedAt: new Date(1000 * 1000).toISOString(),
      finishedAt: null,
      date: "2026-10-03",
      steps: undefined,
    });
  });

  it("maps a finished sub_agent Activity with its Steps", () => {
    const mapped = mapActivity({
      id: "sub_agent:conv_child",
      kind: "sub_agent",
      chat_id: "conv_child",
      title: "Researched Q4 totals",
      outcome: "Found the figures in the Q4 report.",
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
