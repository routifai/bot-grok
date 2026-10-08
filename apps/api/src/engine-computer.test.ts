import { openScreenCapability } from "@nova/core/node/screen-capability";
import type { PrismaClient } from "@nova/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  engineComputerRelease,
  engineComputerScreenUrl,
  engineComputerStatus,
  engineComputerTakeover,
} from "./engine-computer.js";

const client = { baseUrl: "http://omnigent.test", proxySecret: "proxy", secrets: [] };
const actor = { userId: "user-1", spaceId: "space-1" } as never;
const env = { screenProxySecret: "screen-secret", webOrigin: "https://app.example" };

function deps(session: string | null = "sess-1") {
  const prisma = {
    bot: { findFirst: vi.fn(async () => ({ id: "bot-1", screenGeneration: 3 })) },
    user: { findUnique: vi.fn(async () => ({ email: "p@example.test" })) },
    omnigentSession: {
      findUnique: vi.fn(async () => (session ? { omnigentSessionId: session } : null)),
    },
    computer: { update: vi.fn(), updateMany: vi.fn() },
  };
  return { prisma, deps: { prisma: prisma as unknown as PrismaClient, env } };
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
    const calls = stubEngine({ available: true, in_control: true });
    const { prisma, deps: d } = deps();
    const status = await engineComputerStatus(d, client, actor, "bot-1");
    expect(status).toMatchObject({
      state: "running",
      controlHolder: "user",
      controlBotId: "bot-1",
      screenAvailable: true,
    });
    expect(calls(0).path).toBe("/v1/sessions/sess-1/computer");
    expect(prisma.computer.update).not.toHaveBeenCalled();
  });

  it("is stopped without a Conversation yet and does not call the engine", async () => {
    const calls = stubEngine();
    const status = await engineComputerStatus(deps(null).deps, client, actor, "bot-1");
    expect(status).toMatchObject({ state: "stopped", controlHolder: "none" });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(calls).toBeTypeOf("function");
  });

  it("relays the engine's screen through the sealed same-origin proxy", async () => {
    stubEngine(
      { available: true, in_control: false },
      { screen_url: "http://127.0.0.1:6080/vnc.html?token=secret-token", in_control: false },
    );
    const { url } = await engineComputerScreenUrl(deps().deps, client, actor, "bot-1");
    expect(url).toMatch(/^https:\/\/app\.example\/novnc\/session\/view\//);
    expect(url).not.toContain("secret-token");
    const opened = openScreenCapability(new URL(url!).pathname, "screen-secret");
    expect(opened?.scope).toMatchObject({ botId: "bot-1", computerId: "engine", botGeneration: 3 });
    expect(opened?.target).toMatchObject({ hostname: "127.0.0.1", port: 6080, interactive: false });
  });

  it("serves an interactive link while the user is in control", async () => {
    const calls = stubEngine(
      { available: true, in_control: true },
      { screen_url: "http://127.0.0.1:6080/vnc.html?token=t", in_control: true },
    );
    const { url } = await engineComputerScreenUrl(deps().deps, client, actor, "bot-1");
    expect(JSON.parse(calls(1).body)).toEqual({ interactive: true });
    expect(url).toContain("/novnc/session/control/");
  });

  it("has no screen when the Computer is unavailable", async () => {
    stubEngine({ available: false, in_control: false });
    expect(await engineComputerScreenUrl(deps().deps, client, actor, "bot-1")).toEqual({
      url: null,
    });
  });

  it("takes over through the engine and hands back through release", async () => {
    const calls = stubEngine(
      { available: true, in_control: false },
      { screen_url: "http://127.0.0.1:6080/x", in_control: true },
      { screen_url: "http://127.0.0.1:6080/x", in_control: false },
    );
    const { deps: d } = deps();
    const grant = await engineComputerTakeover(d, client, actor, "bot-1");
    expect(grant.leaseId).toBeTruthy();
    expect(JSON.parse(calls(1).body)).toEqual({ interactive: true });
    await expect(engineComputerRelease(d, client, actor, "bot-1")).resolves.toEqual({ ok: true });
    expect(calls(2)).toMatchObject({
      path: "/v1/sessions/sess-1/computer/release",
      method: "POST",
    });
  });

  it("refuses take over when there is no Computer", async () => {
    stubEngine({ available: false, in_control: false });
    await expect(engineComputerTakeover(deps().deps, client, actor, "bot-1")).rejects.toThrow(
      "computer must be running",
    );
  });
});
