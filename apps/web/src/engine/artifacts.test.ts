// @vitest-environment jsdom

import { call } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { artifactsRouter } from "./artifacts";
import { forgetMuseSession } from "./client";

const row = {
  id: "a1",
  parent_session_id: "sess-1",
  name: "report.html",
  title: "Report",
  kind: "html",
  mime: "text/html; charset=utf-8",
  size: 12,
  version: 2,
  versions: 2,
  published: false,
  created_at: 1_700_000_000,
  updated_at: null,
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A session in the Muse's family, as `GET /v1/sessions/{id}` reports it. */
const family = (id: string, kind: "side" | "helper") => ({
  id,
  status: "idle",
  superchat: { kind, root_id: "sess-1", parent_id: "sess-1", seed_item_id: null, project: null },
});

/** Serves the Muse (session `sess-1`) and hands everything else to `rest`. */
function engine(rest: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/me/muse") return json({ session_id: "sess-1" });
      return rest(url, init);
    }),
  );
}

const listSpace = (input: { botId?: string; limit?: number } = {}) =>
  call(artifactsRouter.artifacts.listSpace, input);

beforeEach(() => forgetMuseSession());
afterEach(() => vi.unstubAllGlobals());

describe("artifacts", () => {
  it("lists the Muse's deliverables in the Library's shape", async () => {
    engine((url) => {
      expect(url.pathname).toBe("/v1/artifacts");
      expect(url.searchParams.get("parent_session_id")).toBeNull();
      return json({ artifacts: [row] });
    });
    const page = await listSpace();
    expect(page.nextCursor).toBeNull();
    expect(page.items[0]).toMatchObject({
      id: "a1",
      botId: "sess-1",
      name: "report.html",
      description: "Report",
      mimeType: "text/html",
      version: 2,
      versionCount: 2,
    });
  });

  it("lists deliverables saved in a Side Chat or its Helper under the Muse", async () => {
    const side = { ...row, id: "a2", parent_session_id: "side-1", name: "side.html" };
    const helperSaved = { ...row, id: "a3", parent_session_id: "helper-1", name: "h.html" };
    const stranger = { ...row, id: "a4", parent_session_id: "elsewhere", name: "x.html" };
    engine((url) => {
      if (url.pathname === "/v1/artifacts") {
        return json({ artifacts: [row, side, helperSaved, stranger] });
      }
      if (url.pathname === "/v1/sessions/side-1") return json(family("side-1", "side"));
      if (url.pathname === "/v1/sessions/helper-1") return json(family("helper-1", "helper"));
      return json({ id: "elsewhere", status: "idle", superchat: null });
    });
    const page = await call(artifactsRouter.artifacts.list, { botId: "sess-1" });
    expect(page.map((item) => item.id).sort()).toEqual(["a1", "a2", "a3"]);
    expect(page.every((item) => item.botId === "sess-1")).toBe(true);
  });

  it("resolves each chat's owner from its session once", async () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({
      ...row,
      id: `h${i}`,
      parent_session_id: i % 2 ? "helper-1" : "helper-2",
    }));
    const calls: string[] = [];
    engine((url) => {
      calls.push(url.pathname);
      if (url.pathname === "/v1/artifacts") return json({ artifacts: rows });
      return json(family(url.pathname.split("/").at(-1) ?? "", "helper"));
    });
    const page = await listSpace();
    expect(page.items).toHaveLength(6);
    expect(calls.filter((c) => c === "/v1/sessions/helper-1")).toHaveLength(1);
    expect(calls.filter((c) => c === "/v1/sessions/helper-2")).toHaveLength(1);
  });

  it("honors the requested limit", async () => {
    engine(() => json({ artifacts: [row, { ...row, id: "a2" }, { ...row, id: "a3" }] }));
    const page = await listSpace({ limit: 2 });
    expect(page.items.map((item) => item.id)).toEqual(["a1", "a2"]);
  });

  it("surfaces engine failures instead of dropping rows", async () => {
    engine((url) =>
      url.pathname === "/v1/artifacts"
        ? json({ artifacts: [{ ...row, parent_session_id: "unknown" }] })
        : json({ error: "boom" }, 500),
    );
    await expect(listSpace()).rejects.toThrow();
  });

  it("returns versions, content as base64, and deletes", async () => {
    const detail = {
      ...row,
      all_versions: [
        { id: "a1", version: 2, size: 12, created_at: 1_700_000_100 },
        { id: "a0", version: 1, size: 10, created_at: 1_700_000_000 },
      ],
    };
    engine((url, init) => {
      if (init?.method === "DELETE") return json({ deleted: true });
      if (url.pathname.endsWith("/content")) return new Response("<h1>hi</h1>");
      return json(detail);
    });
    const versions = await call(artifactsRouter.artifacts.listVersions, { familyId: "a1" });
    expect(versions.map((v) => [v.id, v.version])).toEqual([
      ["a1", 2],
      ["a0", 1],
    ]);
    const full = await call(artifactsRouter.artifacts.getById, { artifactId: "a1" });
    expect(atob(full.contentBase64)).toBe("<h1>hi</h1>");
    expect(full.botId).toBe("sess-1");
    expect(await call(artifactsRouter.artifacts.remove, { artifactId: "a1" })).toEqual({
      ok: true,
    });
  });

  it("maps an engine 404 to not-found", async () => {
    engine(() => json({ error: { code: "not_found" } }, 404));
    await expect(
      call(artifactsRouter.artifacts.getById, { artifactId: "zz" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
