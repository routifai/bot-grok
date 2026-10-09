import type { Actor } from "@nova/contracts";
import type { PrismaClient } from "@nova/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { answerAsk, countAsks, listAsks } from "./asks-service.js";

afterEach(() => vi.unstubAllGlobals());

const actor: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@nova.test",
  isDeploymentOwner: true,
};

const engine = { baseUrl: "http://engine.test", proxySecret: "p", secrets: [], tenant: "s" };

function fakeDeps() {
  const prisma = {
    bot: { findFirst: vi.fn().mockResolvedValue({ id: "bot-1" }) },
    omnigentSession: { findUnique: vi.fn().mockResolvedValue(null) },
    user: { findUnique: vi.fn().mockResolvedValue({ email: "p@example.test" }) },
    message: { findFirst: vi.fn(), findMany: vi.fn() },
  };
  return { prisma: prisma as unknown as PrismaClient, raw: prisma };
}

describe("asks without an engine", () => {
  it("answers SERVICE_UNAVAILABLE instead of reading the Conversation", async () => {
    const { prisma, raw } = fakeDeps();
    await expect(listAsks({ prisma }, undefined, actor, "bot-1")).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
    await expect(countAsks({ prisma }, undefined, actor, "bot-1")).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
    await expect(
      answerAsk({ prisma }, undefined, actor, { askId: "approval:a", answer: "approve_once" }),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(raw.message.findMany).not.toHaveBeenCalled();
    expect(raw.message.findFirst).not.toHaveBeenCalled();
  });
});

describe("asks on the engine", () => {
  it("counts the Muse's engine asks (none while it has no session yet)", async () => {
    const { prisma } = fakeDeps();
    await expect(countAsks({ prisma }, engine, actor, "bot-1")).resolves.toEqual({ count: 0 });
  });

  it("answers an engine ask on the engine, never through a Conversation message", async () => {
    const { prisma, raw } = fakeDeps();
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url.pathname} ${String(init?.body)}`);
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const result = await answerAsk({ prisma }, engine, actor, {
      askId: "proposal:obj-1:prop-1",
      answer: "accept",
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([
      'POST /v1/me/asks/proposal%3Aobj-1%3Aprop-1/answer {"choice":"accept"}',
    ]);
    expect(raw.message.findFirst).not.toHaveBeenCalled();
  });

  it("rejects an id the engine did not give", async () => {
    const { prisma } = fakeDeps();
    await expect(
      answerAsk({ prisma }, engine, actor, { askId: "nope", answer: "x" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
