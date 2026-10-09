import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  anonymousViewerKey,
  mountPublishedApps,
  PUBLISHED_APP_CSP,
  type PublishedAppViewer,
} from "./published-apps.js";

const engine = {
  baseUrl: "http://engine.test",
  proxySecret: "proxy",
  secrets: [],
  tenant: "apps-gateway",
};
const HTML = "<!doctype html><title>Todo</title><script>1</script>";

interface Hit {
  method: string;
  path: string;
  body: string | null;
}

function engineStub(audience: "owner" | "org" | "link", owner = "owner@example.test") {
  const hits: Hit[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL, init?: RequestInit) => {
      hits.push({
        method: init?.method ?? "GET",
        path: url.pathname,
        body: (init?.body as string | undefined) ?? null,
      });
      if (url.pathname === "/v1/published/missing-abc123")
        return new Response("{}", { status: 404 });
      if (url.pathname.endsWith("/view")) return Response.json({ counted: true });
      return new Response(HTML, {
        headers: {
          "x-published-audience": audience,
          "x-published-owner": encodeURIComponent(owner),
          "x-published-version": "1",
          "x-published-title": "Todo",
        },
      });
    }),
  );
  return hits;
}

function build(opts: {
  viewer?: PublishedAppViewer | null;
  sharesOrg?: boolean;
  noEngine?: boolean;
  ownerMayAct?: (ownerEmail: string) => Promise<boolean>;
}) {
  const app = new Hono();
  const member = { findFirst: vi.fn(async () => (opts.sharesOrg ? { id: "m1" } : null)) };
  mountPublishedApps(app, {
    prisma: {
      user: { findFirst: vi.fn(async () => ({ id: "owner-id" })) },
      member,
    } as never,
    viewer: async () => opts.viewer ?? null,
    engine: () => (opts.noEngine ? undefined : engine),
    secret: "s3cret",
    ownerMayAct: opts.ownerMayAct,
  });
  return { app, member };
}

const viewer = (email: string, userId = "viewer-id"): PublishedAppViewer => ({ userId, email });

/** The one invariant: every response of /apps/* is sandboxed, whatever its status. */
function expectSandboxed(res: Response) {
  const csp = res.headers.get("content-security-policy") ?? "";
  expect(csp).toBe(PUBLISHED_APP_CSP);
  expect(csp).toMatch(/^sandbox allow-scripts allow-forms allow-popups allow-modals;/);
  expect(csp).not.toContain("allow-same-origin");
  expect(csp).toContain("connect-src 'none'");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
}

afterEach(() => vi.unstubAllGlobals());

describe("published apps gateway", () => {
  it("serves a link app to anyone, sandboxed, and counts the open", async () => {
    const hits = engineStub("link");
    const { app } = build({});
    const res = await app.request("/apps/todo-abc123", {
      headers: { "x-forwarded-for": "203.0.113.9", "user-agent": "ua" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(HTML);
    expectSandboxed(res);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("public, no-cache");
    await vi.waitFor(() => expect(hits.some((h) => h.path.endsWith("/view"))).toBe(true));
    const key = JSON.parse(hits.find((h) => h.path.endsWith("/view"))?.body ?? "{}").viewer_key;
    expect(key).toMatch(/^a:[0-9a-f]{32}$/);
    expect(key).not.toContain("203.0.113.9");
  });

  it("keys signed-in viewers by account id", async () => {
    const hits = engineStub("link");
    const { app } = build({ viewer: viewer("someone@example.test", "acct-7") });
    await app.request("/apps/todo-abc123");
    await vi.waitFor(() => expect(hits.some((h) => h.path.endsWith("/view"))).toBe(true));
    expect(JSON.parse(hits.at(-1)?.body ?? "{}").viewer_key).toBe("u:acct-7");
  });

  it("does not count the owner's own opens", async () => {
    const hits = engineStub("link");
    const { app } = build({ viewer: viewer("Owner@Example.test") });
    expect((await app.request("/apps/todo-abc123")).status).toBe(200);
    await new Promise((r) => setTimeout(r, 10));
    expect(hits.some((h) => h.path.endsWith("/view"))).toBe(false);
  });

  it("owner audience: only the owner opens it, others get a sandboxed 403", async () => {
    engineStub("owner");
    const signedOut = await build({}).app.request("/apps/todo-abc123");
    expect(signedOut.status).toBe(403);
    expectSandboxed(signedOut);
    expect(signedOut.headers.get("cache-control")).toBe("no-store");
    expect(await signedOut.text()).toContain('href="/sign-in"');

    const other = await build({ viewer: viewer("x@example.test"), sharesOrg: true }).app.request(
      "/apps/todo-abc123",
    );
    expect(other.status).toBe(403);
    expectSandboxed(other);
    expect(await other.text()).not.toContain("/sign-in");

    const owner = await build({ viewer: viewer("owner@example.test") }).app.request(
      "/apps/todo-abc123",
    );
    expect(owner.status).toBe(200);
    expectSandboxed(owner);
    expect(owner.headers.get("cache-control")).toBe("no-store");
  });

  it("org audience: members of the owner's organization only", async () => {
    engineStub("org");
    const member = build({ viewer: viewer("mate@example.test"), sharesOrg: true });
    const ok = await member.app.request("/apps/todo-abc123");
    expect(ok.status).toBe(200);
    expectSandboxed(ok);
    expect(member.member.findFirst).toHaveBeenCalledWith({
      where: { userId: "viewer-id", organization: { members: { some: { userId: "owner-id" } } } },
      select: { id: true },
    });
    const outsider = await build({ viewer: viewer("out@example.test") }).app.request(
      "/apps/todo-abc123",
    );
    expect(outsider.status).toBe(403);
    expectSandboxed(outsider);
    const anon = await build({}).app.request("/apps/todo-abc123");
    expect(anon.status).toBe(403);
    expect(await anon.text()).toContain('href="/sign-in"');
  });

  it("404s unknown slugs, malformed slugs and a missing engine, all sandboxed", async () => {
    engineStub("link");
    for (const [path, opts] of [
      ["/apps/missing-abc123", {}],
      ["/apps/..%2Fetc", {}],
      ["/apps/UPPER", {}],
      ["/apps/todo-abc123", { noEngine: true }],
    ] as const) {
      const res = await build(opts).app.request(path);
      expect(res.status).toBe(404);
      expectSandboxed(res);
    }
  });

  it("answers 404 sandboxed when the engine fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    );
    const errors: unknown[] = [];
    const app = new Hono();
    mountPublishedApps(app, {
      prisma: {} as never,
      viewer: async () => null,
      engine: () => engine,
      secret: "s",
      onError: (e) => errors.push(e),
    });
    const res = await app.request("/apps/todo-abc123");
    expect(res.status).toBe(404);
    expectSandboxed(res);
    expect(errors).toHaveLength(1);
  });

  it("stops serving an app whose owner may no longer act, like an unpublished one", async () => {
    engineStub("link", "owner@example.test");
    const ownerMayAct = vi.fn(async () => false);
    const { app } = build({ ownerMayAct });
    const res = await app.request("/apps/todo-abc123");
    expect(res.status).toBe(404);
    expectSandboxed(res);
    expect(ownerMayAct).toHaveBeenCalledWith("owner@example.test");
    const allowed = build({ ownerMayAct: async () => true });
    expect((await allowed.app.request("/apps/todo-abc123")).status).toBe(200);
  });

  it("does not count HEAD requests", async () => {
    const hits = engineStub("link");
    const { app } = build({});
    await app.request("/apps/todo-abc123", { method: "HEAD" });
    await new Promise((r) => setTimeout(r, 10));
    expect(hits.some((h) => h.path.endsWith("/view"))).toBe(false);
  });
});

describe("anonymousViewerKey", () => {
  it("is stable within a day and rotates daily", () => {
    const a = anonymousViewerKey("s", "1.2.3.4", "ua", "2026-10-08");
    expect(anonymousViewerKey("s", "1.2.3.4", "ua", "2026-10-08")).toBe(a);
    expect(anonymousViewerKey("s", "1.2.3.4", "ua", "2026-10-09")).not.toBe(a);
    expect(anonymousViewerKey("s", "1.2.3.5", "ua", "2026-10-08")).not.toBe(a);
    expect(a).not.toContain("1.2.3.4");
  });
});
