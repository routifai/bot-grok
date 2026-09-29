import type { Actor } from "@aiden/contracts";
import type { PrismaClient } from "@aiden/db";
import { RPCHandler } from "@orpc/server/fetch";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRouter, type RouterDeps } from "./router.js";

// engine.info / engine.setHarness (packages/contracts/src/rpc.ts): a router-level smoke test
// that the RPC paths, actor scoping, and env-gated validation are wired correctly end to end —
// the availability matrix and persistence logic itself are covered by engine-info.test.ts.

const actor: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@aiden.test",
  isDeploymentOwner: true,
};

type BotRow = { museHarness: string | null };

function engineDeps(botRow: BotRow | null) {
  const findFirst = vi.fn().mockResolvedValue(botRow);
  const update = vi.fn().mockImplementation(
    async ({ data }: { data: Partial<BotRow> }): Promise<BotRow> => ({
      museHarness: data.museHarness ?? botRow?.museHarness ?? null,
    }),
  );
  const prisma = { bot: { findFirst, update } } as unknown as PrismaClient;
  const deps = {
    prisma,
    env: {
      defaultProvider: "fake",
      defaultModel: "fake-model",
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "fake-test-secret",
      sandboxProvider: "fake",
    },
    dataDir: "/tmp/aiden-engine-router-test",
  } as unknown as RouterDeps;
  return { findFirst, update, handler: new RPCHandler(createRouter(deps)) };
}

async function engineInfo(handler: RPCHandler<{ actor: Actor | null }>, botId: string) {
  return handler.handle(
    new Request("http://127.0.0.1/rpc/engine/info", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: { botId } }),
    }),
    { prefix: "/rpc", context: { actor } },
  );
}

async function setHarness(
  handler: RPCHandler<{ actor: Actor | null }>,
  input: Record<string, unknown>,
) {
  return handler.handle(
    new Request("http://127.0.0.1/rpc/engine/setHarness", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: input }),
    }),
    { prefix: "/rpc", context: { actor } },
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("engine.info", () => {
  it("reports disabled with the full harness catalog when NOVA_ENGINE is unset", async () => {
    vi.stubEnv("NOVA_ENGINE", "");
    const { handler } = engineDeps({ museHarness: null });
    const { response } = await engineInfo(handler, "bot-1");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { json: { enabled: boolean; active: unknown } };
    expect(body.json.enabled).toBe(false);
    expect(body.json.active).toBeNull();
  });

  it("rejects a bot outside the actor's space", async () => {
    const { handler, findFirst } = engineDeps(null);
    const { response } = await engineInfo(handler, "someone-elses-bot");
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(findFirst).toHaveBeenCalled();
  });
});

describe("engine.setHarness", () => {
  it("rejects when Nova is not running on the Omnigent engine", async () => {
    vi.stubEnv("NOVA_ENGINE", "");
    const { handler, update } = engineDeps({ museHarness: null });
    const { response } = await setHarness(handler, { botId: "bot-1", harness: "claude" });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(update).not.toHaveBeenCalled();
  });

  it("persists an available harness and echoes it back as active", async () => {
    vi.stubEnv("NOVA_ENGINE", "omnigent");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant");
    const { handler, update } = engineDeps({ museHarness: null });
    const { response } = await setHarness(handler, { botId: "bot-1", harness: "claude" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { json: { active: string } };
    expect(body.json.active).toBe("claude");
    expect(update).toHaveBeenCalledWith({
      where: { id: "bot-1" },
      data: { museHarness: "claude" },
      select: { museHarness: true },
    });
  });

  it("rejects an unavailable harness", async () => {
    vi.stubEnv("NOVA_ENGINE", "omnigent");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const { handler, update } = engineDeps({ museHarness: null });
    const { response } = await setHarness(handler, { botId: "bot-1", harness: "claude" });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(update).not.toHaveBeenCalled();
  });
});
