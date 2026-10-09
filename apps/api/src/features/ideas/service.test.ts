import type { PrismaClient } from "@nova/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { engineAcceptIdea, engineDismissIdea, engineListIdeas } from "./engine-ideas.js";

const client = { baseUrl: "http://engine.test", proxySecret: "proxy", secrets: [] };
const actor = { userId: "user-1", spaceId: "space-1" } as never;

function deps(sendMessage = vi.fn(async () => undefined), session: string | null = "sess-1") {
  const prisma = {
    bot: { findFirst: vi.fn(async () => ({ id: "bot-1" })) },
    user: { findUnique: vi.fn(async () => ({ email: "p@example.test" })) },
    omnigentSession: {
      findUnique: vi.fn(async () => (session ? { omnigentSessionId: session } : null)),
    },
  };
  return { prisma: prisma as unknown as PrismaClient, sendMessage };
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

const idea = (id: string, extra = {}) => ({
  id,
  parent_session_id: "sess-1",
  title: "Compare the two plans",
  why: "You asked about them twice.",
  message: "Compare the two pension plans for me.",
  status: "open",
  source_session_id: "run-1",
  created_at: 1_700_000_000,
  updated_at: null,
  ...extra,
});

function stub(open = [idea("i1")]) {
  const fetchMock = vi.fn(async (url: URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url.pathname === "/v1/suggestions") {
      expect(url.searchParams.get("parent_session_id")).toBe("sess-1");
      expect(url.searchParams.get("status")).toBe("open");
      return json({ suggestions: open });
    }
    if (method === "PATCH" && url.pathname === "/v1/suggestions/i1") {
      return json(idea("i1", { status: JSON.parse(String(init?.body)).status }));
    }
    throw new Error(`unexpected ${method} ${url.pathname}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const patches = (fetchMock: ReturnType<typeof stub>) =>
  fetchMock.mock.calls
    .filter(([, init]) => init?.method === "PATCH")
    .map(([, init]) => JSON.parse(String(init?.body)).status);

afterEach(() => vi.unstubAllGlobals());

describe("engine ideas", () => {
  it("lists open suggestions in the Idea shape", async () => {
    stub();
    expect(await engineListIdeas(deps(), client, actor, "bot-1")).toEqual([
      {
        id: "i1",
        text: "Compare the two plans",
        area: "suggested",
        detail: "You asked about them twice.",
        createdAt: "2023-11-14T22:13:20.000Z",
      },
    ]);
  });

  it("is empty while the Muse has no Conversation", async () => {
    expect(await engineListIdeas(deps(undefined, null), client, actor, "bot-1")).toEqual([]);
  });

  it("Do it marks the Idea done and sends its message", async () => {
    const fetchMock = stub();
    const d = deps();
    await engineAcceptIdea(d, client, actor, { botId: "bot-1", ideaId: "i1" });
    expect(patches(fetchMock)).toEqual(["done"]);
    expect(d.sendMessage).toHaveBeenCalledWith(
      actor,
      "bot-1",
      "Compare the two pension plans for me.",
    );
  });

  it("gives the Idea back when the message cannot be sent", async () => {
    const fetchMock = stub();
    const d = deps(vi.fn(async () => Promise.reject(new Error("down"))));
    await expect(
      engineAcceptIdea(d, client, actor, { botId: "bot-1", ideaId: "i1" }),
    ).rejects.toThrow("down");
    expect(patches(fetchMock)).toEqual(["done", "open"]);
  });

  it("Dismiss marks it dismissed and never sends", async () => {
    const fetchMock = stub();
    const d = deps();
    await engineDismissIdea(d, client, actor, { botId: "bot-1", ideaId: "i1" });
    expect(patches(fetchMock)).toEqual(["dismissed"]);
    expect(d.sendMessage).not.toHaveBeenCalled();
  });

  it("rejects an Idea that is not open for this Muse", async () => {
    stub([]);
    await expect(
      engineAcceptIdea(deps(), client, actor, { botId: "bot-1", ideaId: "i1" }),
    ).rejects.toThrow("Idea not found");
  });
});
