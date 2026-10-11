import type { PrismaClient } from "@superchat/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  engineComputerRuntime,
  moveEngineComputerRunner,
  setEngineComputerAgent,
} from "./runtime.js";

const client = {
  baseUrl: "http://engine.test/",
  proxySecret: "proxy",
  secrets: [],
  tenant: "space-1",
};
const actor = { userId: "user-1", spaceId: "space-1" } as never;

function deps(session: string | null = "sess-1") {
  const prisma = {
    bot: { findFirst: vi.fn(async () => ({ id: "bot-1" })) },
    user: { findUnique: vi.fn(async () => ({ email: "p@example.test" })) },
    omnigentSession: {
      findUnique: vi.fn(async () =>
        session ? { omnigentSessionId: session, agentName: "superchat-claude" } : null,
      ),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  };
  return { prisma, deps: { prisma: prisma as unknown as PrismaClient } };
}

const AGENTS = {
  data: [
    { id: "ag_1", name: "superchat-claude", harness: "claude-sdk", builtin: true },
    { id: "ag_2", name: "superchat-pi", harness: "pi", builtin: true },
    { id: "ag_3", name: "claude-native-ui", harness: "claude-native", builtin: true },
  ],
};
const LAPTOP = { host_id: "host_laptop", name: "laptop", status: "online", sandbox_provider: null };
const DESK = { host_id: "host_desk", name: "desk", status: "offline", sandbox_provider: null };
const COMPUTER = {
  host_id: "host_box",
  name: "sandbox-box",
  status: "online",
  sandbox_provider: "computer",
};

type Reply = { status?: number; body: unknown };

/** Answers each engine path with its reply; records every call. */
function stubEngine(routes: Record<string, Reply | Reply[]>) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({
        method,
        path: url.pathname,
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      const entry = routes[`${method} ${url.pathname}`];
      const reply = Array.isArray(entry) ? entry.shift() : entry;
      if (!reply) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify(reply.body), {
        status: reply.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}

function engine(session: Record<string, unknown>, hosts: unknown[], info: unknown = {}) {
  return {
    "GET /v1/agents": { body: AGENTS },
    "GET /v1/hosts": { body: { hosts } },
    "GET /v1/info": { body: info },
    "GET /v1/sessions/sess-1": { body: { id: "sess-1", status: "idle", ...session } },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("computer runtime", () => {
  it("lists Superchat's bundles and the managed Computer, which hosts can't take over", async () => {
    stubEngine(
      engine({ host_id: "host_box", labels: { "omnigent.sandbox.provider": "computer" } }, [
        COMPUTER,
        LAPTOP,
      ]),
    );
    const runtime = await engineComputerRuntime(deps().deps, client, actor, "bot-1");
    expect(runtime.agents).toEqual([
      { name: "superchat-claude", harness: "claude-sdk" },
      { name: "superchat-pi", harness: "pi" },
    ]);
    expect(runtime.agent).toBe("superchat-claude");
    expect(runtime.managed).toBe(true);
    expect(runtime.runners).toEqual([
      expect.objectContaining({ hostId: "host_box", kind: "computer", current: true }),
      expect.objectContaining({ hostId: "host_laptop", kind: "host", movable: false }),
    ]);
    expect(runtime.connectCommand).toBeNull();
  });

  it("offers online hosts other than the current one when the Conversation is on a host", async () => {
    stubEngine(
      engine({ host_id: "host_desk" }, [LAPTOP, { ...DESK, status: "online" }], {
        accounts_enabled: true,
      }),
    );
    const runtime = await engineComputerRuntime(deps().deps, client, actor, "bot-1");
    expect(runtime.managed).toBe(false);
    expect(runtime.runners.map((r) => [r.hostId, r.current, r.movable])).toEqual([
      ["host_laptop", false, true],
      ["host_desk", true, false],
    ]);
    expect(runtime.connectCommand).toBe("omni host --server http://engine.test");
  });

  it("offers no move while a reply runs, or to an offline host", async () => {
    stubEngine(engine({ host_id: null, status: "running" }, [LAPTOP, DESK]));
    const runtime = await engineComputerRuntime(deps().deps, client, actor, "bot-1");
    expect(runtime.busy).toBe(true);
    expect(runtime.runners.every((r) => !r.movable)).toBe(true);
  });

  it("shows the managed Computer before its first start registered a host", async () => {
    stubEngine(engine({ host_id: null, labels: { "omnigent.sandbox.provider": "default" } }, []));
    const runtime = await engineComputerRuntime(deps().deps, client, actor, "bot-1");
    expect(runtime.runners).toEqual([
      expect.objectContaining({ hostId: null, kind: "computer", provider: null, online: false }),
    ]);
  });
});

describe("switching the harness", () => {
  it("switches through PUT /v1/me/muse and mirrors the answer", async () => {
    const calls = stubEngine({
      "GET /v1/agents": { body: AGENTS },
      "PUT /v1/me/muse": { body: { session_id: "sess-1", agent: "superchat-pi", created: false } },
    });
    const { prisma, deps: d } = deps();
    await expect(
      setEngineComputerAgent(d, client, actor, "bot-1", "superchat-pi"),
    ).resolves.toEqual({ agent: "superchat-pi" });
    expect(calls[1]).toMatchObject({ method: "PUT", body: { agent: "superchat-pi" } });
    expect(prisma.omnigentSession.updateMany).toHaveBeenCalledWith({
      where: { botId: "bot-1" },
      data: { agentName: "superchat-pi" },
    });
  });

  it("refuses an agent that isn't one of Superchat's bundles", async () => {
    const calls = stubEngine({ "GET /v1/agents": { body: AGENTS } });
    await expect(
      setEngineComputerAgent(deps().deps, client, actor, "bot-1", "claude-native-ui"),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("answers CONFLICT when the engine refuses mid-reply", async () => {
    stubEngine({
      "GET /v1/agents": { body: AGENTS },
      "PUT /v1/me/muse": { status: 409, body: { error: { code: "conflict", message: "busy" } } },
    });
    const { prisma, deps: d } = deps();
    await expect(
      setEngineComputerAgent(d, client, actor, "bot-1", "superchat-pi"),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(prisma.omnigentSession.updateMany).not.toHaveBeenCalled();
  });
});

describe("moving the Conversation", () => {
  it("releases the runner, then launches on the host in its home folder", async () => {
    const calls = stubEngine({
      ...engine({ host_id: "host_desk" }, [LAPTOP, { ...DESK, status: "online" }]),
      "GET /v1/hosts/host_laptop/filesystem": {
        body: { data: [{ path: "/home/p/Documents" }], has_more: true },
      },
      "PATCH /v1/sessions/sess-1": { body: { id: "sess-1" } },
      "POST /v1/hosts/host_laptop/runners": { body: { runner_id: "r1", status: "launching" } },
    });
    await expect(
      moveEngineComputerRunner(deps().deps, client, actor, {
        botId: "bot-1",
        hostId: "host_laptop",
      }),
    ).resolves.toEqual({ hostId: "host_laptop" });
    const writes = calls.filter((c) => c.method !== "GET");
    expect(writes).toEqual([
      {
        method: "PATCH",
        path: "/v1/sessions/sess-1",
        body: { runner_id: "", model_override: "default", silent: true },
      },
      {
        method: "POST",
        path: "/v1/hosts/host_laptop/runners",
        body: { session_id: "sess-1", workspace: "/home/p" },
      },
    ]);
  });

  it("never moves a Conversation off the managed Computer", async () => {
    const calls = stubEngine(
      engine({ host_id: "host_box", labels: { "omnigent.sandbox.provider": "computer" } }, [
        COMPUTER,
        LAPTOP,
      ]),
    );
    await expect(
      moveEngineComputerRunner(deps().deps, client, actor, {
        botId: "bot-1",
        hostId: "host_laptop",
        workspace: "/home/p",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("refuses a host that isn't the person's", async () => {
    stubEngine(engine({ host_id: "host_desk" }, [{ ...DESK, status: "online" }]));
    await expect(
      moveEngineComputerRunner(deps().deps, client, actor, {
        botId: "bot-1",
        hostId: "host_someone_else",
        workspace: "/tmp",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
