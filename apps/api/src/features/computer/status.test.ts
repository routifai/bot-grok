import { describe, expect, it } from "vitest";
import { toComputerStatus } from "./status.js";

describe("toComputerStatus", () => {
  it("passes through the busy bot name when another bot is using it", () => {
    const computer = {
      kind: "fake",
      state: "running",
      scope: "team",
      homeRevision: "revision-1",
    };
    expect(toComputerStatus("bot-1", computer).busyBotName).toBeNull();
    expect(toComputerStatus("bot-1", computer, "Writer").busyBotName).toBe("Writer");
  });

  it("hides update on desktop computers", () => {
    expect(
      toComputerStatus("bot-1", {
        kind: "desktop",
        state: "running",
        scope: "team",
        homeRevision: "r1",
      }).canUpdate,
    ).toBe(false);
    expect(
      toComputerStatus("bot-1", {
        kind: "e2b",
        state: "running",
        scope: "team",
        homeRevision: "r1",
      }).canUpdate,
    ).toBe(true);
  });
});
