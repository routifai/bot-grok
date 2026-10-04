import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { forgetScreenRegistry, loadScreenRegistry, saveScreenRegistry } from "./screen-registry.js";

describe("screen registry persistence", () => {
  it("restores assignments and view tokens after a supervisor restart", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "screens-"));
    await saveScreenRegistry(
      dir,
      "abc123",
      new Map([
        ["bot-1", { index: 0, viewToken: "tok-1", leaseId: "l:1" }],
        ["bot-2", { index: 1, viewToken: "tok-2", releasing: true }],
        ["bot-3", { index: 2 }],
      ]),
    );
    const restored = await loadScreenRegistry(dir, "abc123");
    expect([...restored.keys()]).toEqual(["bot-1"]);
    expect(restored.get("bot-1")).toEqual({ index: 0, viewToken: "tok-1", leaseId: "l:1" });
    await forgetScreenRegistry(dir, "abc123");
    expect((await loadScreenRegistry(dir, "abc123")).size).toBe(0);
  });
  it("ignores damaged or unsafe state so the caller falls back to a reset", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "screens-"));
    await saveScreenRegistry(dir, "../escape", new Map([["b", { index: 0, viewToken: "t" }]]));
    expect((await loadScreenRegistry(dir, "../escape")).size).toBe(0);
    await saveScreenRegistry(dir, "ok", new Map([["b", { index: 0, viewToken: "t" }]]));
    await writeFile(
      path.join(dir, "computer-screens", "ok.json"),
      '[{"screenKey":"b","index":0,"viewToken":"bad token!"}]',
    );
    expect((await loadScreenRegistry(dir, "ok")).size).toBe(0);
    await writeFile(path.join(dir, "computer-screens", "ok.json"), "not json");
    expect((await loadScreenRegistry(dir, "ok")).size).toBe(0);
  });
});
