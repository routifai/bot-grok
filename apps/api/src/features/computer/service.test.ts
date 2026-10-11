import type { PrismaClient } from "@superchat/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { engineComputerStatus } from "./service.js";

const client = { baseUrl: "http://omnigent.test", proxySecret: "proxy", secrets: [] };
const actor = { userId: "user-1", spaceId: "space-1" } as never;

function deps(session: string | null = "sess-1") {
  const prisma = {
    bot: { findFirst: vi.fn(async () => ({ id: "bot-1" })) },
    user: { findUnique: vi.fn(async () => ({ email: "p@example.test" })) },
    omnigentSession: {
      findUnique: vi.fn(async () => (session ? { omnigentSessionId: session } : null)),
    },
    computer: { update: vi.fn(), updateMany: vi.fn() },
  };
  return { prisma, deps: { prisma: prisma as unknown as PrismaClient } };
}

function stubEngine(...bodies: unknown[]) {
  const fetchMock = vi.fn();
  for (const body of bodies) {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
    );
  }
  vi.stubGlobal("fetch", fetchMock);
  return (i: number) => {
    const [url, init] = fetchMock.mock.calls[i] as unknown as [URL, RequestInit];
    return { path: url.pathname, method: init?.method ?? "GET", body: init?.body as string };
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("engine-owned computer", () => {
  it("reports status from the engine and never touches Computer rows", async () => {
    const calls = stubEngine({ ready: true, launch: null });
    const { prisma, deps: d } = deps();
    const status = await engineComputerStatus(d, client, actor, "bot-1");
    expect(status).toMatchObject({ state: "running", runnerReady: true });
    expect(calls(0).path).toBe("/v1/sessions/sess-1/computer");
    expect(prisma.computer.update).not.toHaveBeenCalled();
  });

  it("reports the launch stage while the Computer starts, and drops it once ready", async () => {
    stubEngine(
      { ready: false, launch: { stage: "starting", error: null } },
      { ready: true, launch: null },
    );
    const { deps: d } = deps();
    expect((await engineComputerStatus(d, client, actor, "bot-1")).launch).toEqual({
      stage: "starting",
    });
    expect((await engineComputerStatus(d, client, actor, "bot-1")).launch).toBeUndefined();
  });

  it("is stopped while the runner is not connected", async () => {
    stubEngine({ ready: false, launch: null });
    const status = await engineComputerStatus(deps().deps, client, actor, "bot-1");
    expect(status).toMatchObject({ state: "stopped", runnerReady: false });
  });

  it("is stopped without a Conversation yet and does not call the engine", async () => {
    stubEngine();
    const status = await engineComputerStatus(deps(null).deps, client, actor, "bot-1");
    expect(status).toMatchObject({ state: "stopped" });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
