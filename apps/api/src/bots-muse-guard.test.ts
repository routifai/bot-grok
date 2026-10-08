import type { Actor } from "@nova/contracts";
import type { PrismaClient } from "@nova/db";
import { RPCHandler } from "@orpc/server/fetch";
import { describe, expect, it, vi } from "vitest";
import { assertMuseSingleBotAllowed, createRouter, type RouterDeps } from "./router.js";

// ADR 0001: a person has exactly one live Muse. `bots.create`, `bots.duplicate`,
// and `bots.restore` must reject creating a second live bot, except the
// idempotent onboarding re-create (matching spawnKey), which must keep
// returning the existing bot rather than being locked out.

describe("assertMuseSingleBotAllowed", () => {
  it("allows the first create when there is no live bot", () => {
    expect(() => assertMuseSingleBotAllowed(null, null)).not.toThrow();
  });

  it("rejects a second create with no matching spawnKey", () => {
    expect(() => assertMuseSingleBotAllowed({ spawnKey: null }, null)).toThrow(
      /already have a Muse/,
    );
    expect(() =>
      assertMuseSingleBotAllowed({ spawnKey: "onboarding:first" }, "something-else"),
    ).toThrow(/already have a Muse/);
  });

  it("allows the idempotent onboarding re-create (matching spawnKey)", () => {
    expect(() =>
      assertMuseSingleBotAllowed({ spawnKey: "onboarding:first" }, "onboarding:first"),
    ).not.toThrow();
  });

  it("never treats a missing requested key as matching a bot with no spawnKey", () => {
    expect(() => assertMuseSingleBotAllowed({ spawnKey: null }, null)).toThrow();
  });
});

const actor: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@nova.test",
  isDeploymentOwner: true,
};

/** Full valid `Bot` fixture (see `mapBot` in packages/db/src/repos.ts) for a successful create. */
function createdBotRow(spawnKey: string | null) {
  return {
    id: "bot-new",
    spaceId: actor.spaceId,
    name: "New Muse",
    title: "",
    description: "",
    instructions: "",
    color: "#0090FF",
    notifyOnFinish: true,
    pinned: false,
    sectionId: null,
    archivedAt: null,
    parentBotId: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    thread: { id: "thread-new", unread: false },
    computer: { scope: "team" },
    spawnKey,
  };
}

function routerDeps(
  guardLiveBot: { id: string; spawnKey: string | null } | null,
  createdSpawnKey: string | null = null,
) {
  const findFirst = vi.fn(async () => guardLiveBot);
  const count = vi.fn(async () => 0);
  const update = vi.fn(async () => ({}));
  const txBot = {
    aggregate: vi.fn(async () => ({ _max: { position: null } })),
    create: vi.fn(async () => ({ id: "bot-new" })),
    findFirstOrThrow: vi.fn(async () => createdBotRow(createdSpawnKey)),
  };
  const tx = {
    $queryRaw: vi.fn(async () => []),
    spaceMember: {
      findUnique: vi.fn(async () => ({ organizationId: "org-1", space: { deletingAt: null } })),
    },
    bot: txBot,
    computer: { upsert: vi.fn(async () => ({ id: "computer-1" })) },
    thread: { create: vi.fn(async () => ({ id: "thread-new" })) },
    browserProfile: { create: vi.fn(async () => ({})) },
  };
  const transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx));
  const prisma = {
    bot: { findFirst, count, update },
    deploymentSettings: { findUnique: vi.fn(async () => null) },
    $transaction: transaction,
  } as unknown as PrismaClient;
  const deps = {
    prisma,
    env: {
      agentRuntime: "scripted",
      defaultProvider: "fake",
      defaultModel: "fake-model",
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "fake-test-secret",
      sandboxProvider: "fake",
    },
    dataDir: "/tmp/nova-bots-muse-guard-test",
  } as unknown as RouterDeps;
  return { deps, findFirst, transaction, handler: new RPCHandler(createRouter(deps)) };
}

async function call(handler: RPCHandler<{ actor: Actor | null }>, path: string, input: unknown) {
  return handler.handle(
    new Request(`http://127.0.0.1/rpc/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: input }),
    }),
    { prefix: "/rpc", context: { actor } },
  );
}

describe("bots.create — muse single-Muse guard", () => {
  it("rejects a second create when a live bot already exists", async () => {
    const { handler, transaction } = routerDeps({ id: "bot-live", spawnKey: null });

    const { response } = await call(handler, "bots/create", { name: "Another Muse" });

    expect(response.status).toBe(403);
    const body = (await response.json()) as { json: { message: string } };
    expect(body.json.message).toMatch(/already have a Muse/);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("allows the first create when there is no live bot yet", async () => {
    const { handler } = routerDeps(null);

    const { response } = await call(handler, "bots/create", { name: "My Muse" });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { json: { id: string } };
    expect(body.json.id).toBe("bot-new");
  });

  it("keeps the onboarding idempotent re-create working (matching spawnKey)", async () => {
    const { handler } = routerDeps(
      { id: "bot-existing", spawnKey: "onboarding:first" },
      "onboarding:first",
    );

    const { response } = await call(handler, "bots/create", {
      name: "My Muse",
      spawnKey: "onboarding:first",
    });

    expect(response.status).toBe(200);
  });
});

describe("bots.duplicate — muse single-Muse guard", () => {
  it("is always locked", async () => {
    const { handler, findFirst } = routerDeps(null);

    const { response } = await call(handler, "bots/duplicate", { botId: "bot-1" });

    expect(response.status).toBe(403);
    const body = (await response.json()) as { json: { message: string } };
    expect(body.json.message).toMatch(/already have a Muse/);
    expect(findFirst).not.toHaveBeenCalled();
  });
});

describe("bots.restore — muse single-Muse guard", () => {
  function restoreDeps(otherLiveBot: boolean) {
    const findFirst = vi.fn(async ({ where }: { where: { archivedAt?: unknown } }) => {
      if ("archivedAt" in where && where.archivedAt === null) {
        return otherLiveBot ? { id: "bot-live-other", spawnKey: null } : null;
      }
      return {
        id: "bot-archived",
        archivedAt: new Date("2026-01-01T00:00:00.000Z"),
        computer: null,
        thread: { id: "thread-archived" },
      };
    });
    const update = vi.fn(async () => ({}));
    const prisma = {
      bot: { findFirst, update },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/nova-bots-muse-guard-test",
    } as unknown as RouterDeps;
    return { handler: new RPCHandler(createRouter(deps)), update };
  }

  it("rejects restoring a second live bot", async () => {
    const { handler, update } = restoreDeps(true);

    const { response } = await call(handler, "bots/restore", { botId: "bot-archived" });

    expect(response.status).toBe(403);
    expect(update).not.toHaveBeenCalled();
  });

  it("allows restoring when it is the person's only bot", async () => {
    const { handler } = restoreDeps(false);

    const { response } = await call(handler, "bots/restore", { botId: "bot-archived" });

    expect(response.status).toBe(200);
  });
});
