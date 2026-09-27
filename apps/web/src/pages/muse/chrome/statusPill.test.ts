import { describe, expect, it } from "vitest";
import { deriveStatusPill } from "./statusPill";

const NOW = new Date("2026-09-27T12:00:00.000Z").getTime();

describe("deriveStatusPill", () => {
  it("shows idle, neutral tone, when nothing is running and no Goal was recently worked", () => {
    const result = deriveStatusPill({
      museName: "Nova",
      goals: [{ status: "active", lastWorkedAt: null }],
      running: false,
      openAskCount: 0,
      now: NOW,
    });
    expect(result).toEqual({ tone: "neutral", text: "Nova is idle" });
  });

  it("counts active Goals worked on within the last day, live while running", () => {
    const result = deriveStatusPill({
      museName: "Nova",
      goals: [
        { status: "active", lastWorkedAt: new Date(NOW - 4 * 60_000).toISOString() },
        { status: "active", lastWorkedAt: new Date(NOW - 2 * 60 * 60_000).toISOString() },
        // paused/done Goals never count, however recent.
        { status: "paused", lastWorkedAt: new Date(NOW - 60_000).toISOString() },
        { status: "done", lastWorkedAt: new Date(NOW - 60_000).toISOString() },
      ],
      running: true,
      openAskCount: 0,
      now: NOW,
    });
    expect(result).toEqual({
      tone: "live",
      text: "Nova is on 3 things · last check 4m ago",
    });
  });

  it("ignores work older than the recent window", () => {
    const result = deriveStatusPill({
      museName: "Nova",
      goals: [{ status: "active", lastWorkedAt: new Date(NOW - 48 * 60 * 60_000).toISOString() }],
      running: false,
      openAskCount: 0,
      now: NOW,
    });
    expect(result).toEqual({ tone: "neutral", text: "Nova is idle" });
  });

  it("prefers attention when an Ask is open, regardless of running state", () => {
    const result = deriveStatusPill({
      museName: "Nova",
      goals: [{ status: "active", lastWorkedAt: new Date(NOW - 60_000).toISOString() }],
      running: true,
      openAskCount: 2,
      now: NOW,
    });
    expect(result).toEqual({ tone: "attention", text: "Nova is waiting on you" });
  });

  it("counts a running turn as one thing even with no recent Goal work", () => {
    const result = deriveStatusPill({
      museName: "Nova",
      goals: [],
      running: true,
      openAskCount: 0,
      now: NOW,
    });
    expect(result).toEqual({ tone: "live", text: "Nova is on 1 thing · last check just now" });
  });
});
