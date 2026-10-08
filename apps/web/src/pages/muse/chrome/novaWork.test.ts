import type { Activity } from "@aiden/contracts";
import { describe, expect, it } from "vitest";
import { deriveNovaWork } from "./novaWork";

function activity(id: string, status: Activity["status"], parentId?: string): Activity {
  return {
    id,
    status,
    title: id,
    startedAt: "2026-10-07T10:00:00.000Z",
    ...(parentId ? { parentId } : {}),
  } as unknown as Activity;
}

describe("deriveNovaWork", () => {
  it("is ready with nothing running", () => {
    expect(deriveNovaWork("idle", [activity("a", "done")])).toEqual({ orb: "idle", count: 0 });
  });

  it("counts running Activities, so every orb brightens", () => {
    expect(
      deriveNovaWork("idle", [activity("a", "in_progress"), activity("b", "in_progress")]),
    ).toEqual({
      orb: "working",
      count: 2,
    });
  });

  it("counts a running turn the feed has not listed yet as one thing", () => {
    expect(deriveNovaWork("thinking", [])).toEqual({ orb: "working", count: 1 });
    expect(deriveNovaWork("working", [])).toEqual({ orb: "working", count: 1 });
  });

  it("rests while only waiting on the person", () => {
    expect(deriveNovaWork("waiting", [])).toEqual({ orb: "idle", count: 0 });
  });
});
