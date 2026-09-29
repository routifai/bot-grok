import type { MemoryStore } from "@aiden/adapter-kit";
import type { PrismaClient } from "@aiden/db";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { mountOmnigentContextRoute, OMNIGENT_CONTEXT_PATH } from "./omnigent-context.js";

const SECRET = "omnigent-context-test-secret-32chars!";

const BOT = {
  id: "bot-1",
  userId: "user-1",
  spaceId: "space-1",
  name: "muse",
  title: "The Muse",
  description: "Personal AI",
  instructions: "Be helpful.",
};

function fakePrisma(): PrismaClient {
  return {
    bot: { findUnique: vi.fn(async () => BOT) },
    user: { findUnique: vi.fn(async () => ({ timezone: "UTC" })) },
    taughtSkill: { findMany: vi.fn(async () => []) },
    agentSkill: { findMany: vi.fn(async () => []) },
    episode: { findMany: vi.fn(async () => []) },
    goal: { findMany: vi.fn(async () => []) },
    scratchpadItem: { findMany: vi.fn(async () => []) },
  } as unknown as PrismaClient;
}

function fakeMemory(): MemoryStore {
  return { read: vi.fn(async () => ({ documents: [] })) } as unknown as MemoryStore;
}

function buildApp(contextProviderSecret: string | undefined) {
  const app = new Hono();
  mountOmnigentContextRoute(app, {
    prisma: fakePrisma(),
    memory: fakeMemory(),
    secrets: [],
    contextProviderSecret,
  });
  return app;
}

const VALID_LABELS = {
  "nova.user": "user-1",
  "nova.space": "space-1",
  "nova.bot": "bot-1",
  "nova.scope": "private",
};

describe("mountOmnigentContextRoute", () => {
  it("404s when the context-provider secret is unset", async () => {
    const app = buildApp(undefined);
    const res = await app.request(OMNIGENT_CONTEXT_PATH, {
      method: "POST",
      headers: { authorization: "Bearer anything", "content-type": "application/json" },
      body: JSON.stringify({ labels: VALID_LABELS, turn_input: "hi" }),
    });
    expect(res.status).toBe(404);
  });

  it("401s on a missing or wrong bearer token", async () => {
    const app = buildApp(SECRET);
    const noAuth = await app.request(OMNIGENT_CONTEXT_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ labels: VALID_LABELS, turn_input: "hi" }),
    });
    expect(noAuth.status).toBe(401);

    const wrongAuth = await app.request(OMNIGENT_CONTEXT_PATH, {
      method: "POST",
      headers: { authorization: "Bearer wrong-secret", "content-type": "application/json" },
      body: JSON.stringify({ labels: VALID_LABELS, turn_input: "hi" }),
    });
    expect(wrongAuth.status).toBe(401);
  });

  it("returns composed instructions for a valid request", async () => {
    const app = buildApp(SECRET);
    const res = await app.request(OMNIGENT_CONTEXT_PATH, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "conv_1",
        agent_name: "nova-pi",
        harness: "pi",
        user_id: null,
        labels: VALID_LABELS,
        turn_input: "hi",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { instructions: string };
    expect(body.instructions).toContain("Be helpful.");
  });

  it("returns empty instructions for a malformed body instead of erroring", async () => {
    const app = buildApp(SECRET);
    const res = await app.request(OMNIGENT_CONTEXT_PATH, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ instructions: "" });
  });

  it("returns empty instructions when labels are missing", async () => {
    const app = buildApp(SECRET);
    const res = await app.request(OMNIGENT_CONTEXT_PATH, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
      body: JSON.stringify({ turn_input: "hi" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ instructions: "" });
  });
});
