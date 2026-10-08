import type { PrismaClient } from "@aiden/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  engineGetArtifact,
  engineListArtifactVersions,
  engineListSpaceArtifacts,
  engineRemoveArtifact,
} from "./engine-artifacts.js";

const client = {
  baseUrl: "http://engine.test",
  proxySecret: "proxy",
  secrets: [],
  tenant: "space-1",
};
const actor = { userId: "user-1", spaceId: "space-1" } as never;
const prisma = {
  bot: {
    findFirst: vi.fn(async () => ({
      id: "bot-1",
      omnigentSession: { omnigentSessionId: "sess-1" },
    })),
  },
  user: { findUnique: vi.fn(async () => ({ email: "p@example.test" })) },
  omnigentSession: {
    findMany: vi.fn(async () => [{ omnigentSessionId: "sess-1", botId: "bot-1" }]),
  },
} as unknown as PrismaClient;
const deps = { prisma };

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

afterEach(() => vi.unstubAllGlobals());

describe("engine artifacts", () => {
  it("lists a Muse's deliverables in the Library's shape", async () => {
    const fetchMock = vi.fn(async (url: URL) => {
      if (url.pathname.endsWith("/related_chats")) return json({ data: [] });
      expect(url.pathname).toBe("/v1/artifacts");
      expect(url.searchParams.get("parent_session_id")).toBeNull();
      return json({ artifacts: [row] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const page = await engineListSpaceArtifacts(deps, client, actor, { botId: "bot-1" });
    expect(page.nextCursor).toBeNull();
    expect(page.items[0]).toMatchObject({
      id: "a1",
      botId: "bot-1",
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        if (url.pathname === "/v1/artifacts") {
          return json({ artifacts: [row, side, helperSaved, stranger] });
        }
        if (url.pathname === "/v1/sessions/side-1") return json(family("side-1", "side"));
        if (url.pathname === "/v1/sessions/helper-1") return json(family("helper-1", "helper"));
        if (url.pathname === "/v1/sessions/elsewhere") {
          return json({ id: "elsewhere", status: "idle", superchat: null });
        }
        return json({ data: [] });
      }),
    );
    const page = await engineListSpaceArtifacts(deps, client, actor, { botId: "bot-1" });
    expect(page.items.map((item) => item.id).sort()).toEqual(["a1", "a2", "a3"]);
    expect(page.items.every((item) => item.botId === "bot-1")).toBe(true);
    const all = await engineListSpaceArtifacts(deps, client, actor, {});
    expect(all.items.map((item) => item.id).sort()).toEqual(["a1", "a2", "a3"]);
  });

  it("resolves each chat's owner from its session once", async () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({
      ...row,
      id: `h${i}`,
      parent_session_id: i % 2 ? "helper-1" : "helper-2",
    }));
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        calls.push(url.pathname);
        if (url.pathname === "/v1/artifacts") return json({ artifacts: rows });
        return json(family(url.pathname.split("/").at(-1) ?? "", "helper"));
      }),
    );
    const page = await engineListSpaceArtifacts(deps, client, actor, {});
    expect(page.items).toHaveLength(6);
    expect(calls.filter((c) => c === "/v1/sessions/helper-1")).toHaveLength(1);
    expect(calls.filter((c) => c === "/v1/sessions/helper-2")).toHaveLength(1);
  });

  it("honors the requested limit", async () => {
    const rows = [row, { ...row, id: "a2" }, { ...row, id: "a3" }];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) =>
        url.pathname === "/v1/artifacts" ? json({ artifacts: rows }) : json({ data: [] }),
      ),
    );
    const page = await engineListSpaceArtifacts(deps, client, actor, { limit: 2 });
    expect(page.items.map((item) => item.id)).toEqual(["a1", "a2"]);
  });

  it("surfaces engine failures instead of dropping rows", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        if (url.pathname === "/v1/artifacts") {
          return json({ artifacts: [{ ...row, parent_session_id: "unknown" }] });
        }
        if (url.pathname === "/v1/sessions/unknown") return json({ error: "boom" }, 500);
        return json({ data: [] });
      }),
    );
    await expect(engineListSpaceArtifacts(deps, client, actor, {})).rejects.toThrow();
  });

  it("returns versions, content as base64, and deletes", async () => {
    const detail = {
      ...row,
      all_versions: [
        { id: "a1", version: 2, size: 12, created_at: 1_700_000_100 },
        { id: "a0", version: 1, size: 10, created_at: 1_700_000_000 },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init?: RequestInit) => {
        if (init?.method === "DELETE") return json({ deleted: true });
        if (url.pathname.endsWith("/content")) return new Response("<h1>hi</h1>");
        if (url.pathname.endsWith("/related_chats")) return json({ data: [] });
        return json(detail);
      }),
    );
    const versions = await engineListArtifactVersions(deps, client, actor, "a1");
    expect(versions.map((v) => [v.id, v.version])).toEqual([
      ["a1", 2],
      ["a0", 1],
    ]);
    const full = await engineGetArtifact(deps, client, actor, "a1");
    expect(Buffer.from(full.contentBase64, "base64").toString()).toBe("<h1>hi</h1>");
    expect(full.botId).toBe("bot-1");
    expect(await engineRemoveArtifact(deps, client, actor, "a1")).toEqual({ ok: true });
  });

  it("maps an engine 404 to not-found", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ error: { code: "not_found" } }, 404)),
    );
    await expect(engineGetArtifact(deps, client, actor, "zz")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
