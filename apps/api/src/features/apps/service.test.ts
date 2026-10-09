import type { PrismaClient } from "@nova/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { enginePublishArtifact, engineUnpublishArtifact } from "./service.js";

const client = {
  baseUrl: "http://engine.test",
  proxySecret: "proxy",
  secrets: [],
  tenant: "space-1",
};
const actor = { userId: "user-1", spaceId: "space-1" } as never;
const prisma = {
  user: { findUnique: vi.fn(async () => ({ email: "p@example.test" })) },
} as unknown as PrismaClient;
const deps = { prisma };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("engine apps", () => {
  it("publishes, maps the address and view counts, and unpublishes", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (init?.method === "DELETE") return json({ unpublished: true });
      expect(JSON.parse(String(init?.body))).toEqual({ audience: "org" });
      return json({
        slug: "report-k3m9xq",
        url_path: "/apps/report-k3m9xq",
        audience: "org",
        version: 2,
        published_at: 1_700_000_000,
        updated_at: null,
        stats: { opens_total: 5, unique_viewers: 3, opens_7d: 4 },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const published = await enginePublishArtifact(deps, client, actor, {
      artifactId: "a1",
      audience: "org",
    });
    expect(published).toMatchObject({
      slug: "report-k3m9xq",
      urlPath: "/apps/report-k3m9xq",
      audience: "org",
      stats: { opensTotal: 5, uniqueViewers: 3, opens7d: 4 },
    });
    await expect(engineUnpublishArtifact(deps, client, actor, "a1")).resolves.toEqual({ ok: true });
    expect(calls).toEqual(["POST /v1/artifacts/a1/publish", "DELETE /v1/artifacts/a1/publish"]);
  });
});
