import { afterEach, describe, expect, it, vi } from "vitest";
import { getOmnigentWorkingProject } from "./projects.js";

const CONFIG = { baseUrl: "http://omnigent.test", proxySecret: "proxy-secret", tenant: "space-1" };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("getOmnigentWorkingProject", () => {
  it("reads the Project from the session's Super Chat block", async () => {
    const fetchMock = vi.fn(async () =>
      json({
        id: "conv_1",
        status: "idle",
        superchat: { kind: "super", project: { slug: "q3-deck", name: "Q3 board deck" } },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(getOmnigentWorkingProject(CONFIG, "a@b.c", "conv_1")).resolves.toEqual({
      slug: "q3-deck",
      name: "Q3 board deck",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("is null with no Project open, or outside a Super Chat family", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({ id: "conv_1", status: "idle", superchat: { kind: "super", project: null } }),
      ),
    );
    await expect(getOmnigentWorkingProject(CONFIG, "a@b.c", "conv_1")).resolves.toBeNull();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ id: "conv_1", status: "idle", superchat: null })),
    );
    await expect(getOmnigentWorkingProject(CONFIG, "a@b.c", "conv_1")).resolves.toBeNull();
  });
});
