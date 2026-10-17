import type { Activity } from "@superchat/contracts";
import { describe, expect, it } from "vitest";
import { deriveSuperchatWork } from "./superchatWork";

function activity(id: string, status: Activity["status"], parentId?: string): Activity {
  return {
    id,
    status,
    title: id,
    startedAt: "2026-10-07T10:00:00.000Z",
    ...(parentId ? { parentId } : {}),
  } as unknown as Activity;
}

describe("deriveSuperchatWork", () => {
  it("is ready with nothing running", () => {
    expect(deriveSuperchatWork("idle", [activity("a", "done")])).toEqual({ orb: "idle", count: 0 });
  });

  it("counts running Activities, so every orb brightens", () => {
    expect(
      deriveSuperchatWork("idle", [activity("a", "in_progress"), activity("b", "in_progress")]),
    ).toEqual({
      orb: "working",
      count: 2,
    });
  });

  it("counts a running turn the feed has not listed yet as one thing", () => {
    expect(deriveSuperchatWork("thinking", [])).toEqual({ orb: "working", count: 1 });
    expect(deriveSuperchatWork("working", [])).toEqual({ orb: "working", count: 1 });
  });

  it("rests while only waiting on the person", () => {
    expect(deriveSuperchatWork("waiting", [])).toEqual({ orb: "idle", count: 0 });
  });
});
