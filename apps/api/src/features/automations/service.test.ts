import type { Actor } from "@superchat/contracts";
import type { PrismaClient } from "@superchat/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { listTasks, createTask, patchTask, runTask, deleteTask } = vi.hoisted(() => ({
  listTasks: vi.fn(),
  createTask: vi.fn(),
  patchTask: vi.fn(),
  runTask: vi.fn(),
  deleteTask: vi.fn(),
}));

vi.mock("@superchat/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@superchat/adapters")>()),
  listOmnigentScheduledTasks: listTasks,
  createOmnigentScheduledTask: createTask,
  patchOmnigentScheduledTask: patchTask,
  runOmnigentScheduledTask: runTask,
  deleteOmnigentScheduledTask: deleteTask,
}));

const {
  engineCreateAutomation,
  engineListAutomations,
  engineRemoveAutomation,
  engineRunAutomation,
  engineUpdateAutomation,
} = await import("./service.js");

const actor = { spaceId: "sp", userId: "u1" } as Actor;
const client = { baseUrl: "http://engine.test" } as never;
const task = (over: Record<string, unknown> = {}) => ({
  id: "t1",
  name: "Morning brief",
  prompt: "Summarise my inbox",
  rrule: "FREQ=DAILY;BYHOUR=8;BYMINUTE=0",
  timezone: "Europe/Paris",
  state: "active",
  kind: "automation",
  created_at: 1_700_000_000,
  last_run_at: 1_700_003_600,
  last_run_status: "succeeded",
  next_run_at: "2026-01-02T08:00:00+01:00",
  ...over,
});

function prismaFor(session: string | null, ownsBot = true) {
  return {
    bot: { findFirst: vi.fn(async () => (ownsBot ? { id: "b1" } : null)) },
    user: { findUnique: vi.fn(async () => ({ email: "a@example.test" })) },
    omnigentSession: {
      findUnique: vi.fn(async () => (session ? { omnigentSessionId: session } : null)),
    },
  } as unknown as PrismaClient;
}

beforeEach(() => vi.resetAllMocks());

describe("engine automations", () => {
  it("lists only automation tasks bound to the Muse's Super Chat", async () => {
    listTasks.mockResolvedValue([task(), task({ id: "t2", kind: "followed_topic" })]);
    const list = await engineListAutomations({ prisma: prismaFor("s1") }, client, actor, "b1");
    expect(listTasks).toHaveBeenCalledWith(client, "a@example.test", "s1");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: "t1",
      enabled: true,
      schedule: { frequency: "daily", time: "08:00" },
      lastRunStatus: "succeeded",
      nextRunAt: "2026-01-02T08:00:00+01:00",
    });
  });

  it("lists nothing before the Muse has a Conversation, and refuses another person's Muse", async () => {
    expect(await engineListAutomations({ prisma: prismaFor(null) }, client, actor, "b1")).toEqual(
      [],
    );
    await expect(
      engineListAutomations({ prisma: prismaFor("s1", false) }, client, actor, "b1"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("creates a Helper task marked automation with the rule built from the choices", async () => {
    createTask.mockResolvedValue(task());
    await engineCreateAutomation({ prisma: prismaFor("s1") }, client, actor, {
      botId: "b1",
      name: "Morning brief",
      prompt: "Summarise my inbox",
      schedule: { frequency: "daily", time: "08:00" },
      timezone: "Europe/Paris",
    });
    expect(createTask).toHaveBeenCalledWith(client, "a@example.test", {
      name: "Morning brief",
      prompt: "Summarise my inbox",
      rrule: "FREQ=DAILY;BYHOUR=8;BYMINUTE=0",
      parentSessionId: "s1",
      agentType: "worker",
      kind: "automation",
      timezone: "Europe/Paris",
    });
  });

  it("passes a chosen model to the task and reads it back", async () => {
    createTask.mockResolvedValue(task({ model_override: "claude-haiku-4-5" }));
    const created = await engineCreateAutomation({ prisma: prismaFor("s1") }, client, actor, {
      botId: "b1",
      name: "Quick check",
      prompt: "Anything new?",
      schedule: { frequency: "daily", time: "08:00" },
      model: "claude-haiku-4-5",
    });
    expect(createTask).toHaveBeenCalledWith(
      client,
      "a@example.test",
      expect.objectContaining({ modelOverride: "claude-haiku-4-5" }),
    );
    expect(created.model).toBe("claude-haiku-4-5");
  });

  it("pauses, runs and removes only automations of this Muse", async () => {
    listTasks.mockResolvedValue([task(), task({ id: "other", kind: "followed_topic" })]);
    patchTask.mockResolvedValue(task({ state: "paused" }));
    const deps = { prisma: prismaFor("s1") };
    const paused = await engineUpdateAutomation(deps, client, actor, {
      botId: "b1",
      id: "t1",
      enabled: false,
    });
    expect(patchTask).toHaveBeenCalledWith(client, "a@example.test", "t1", { state: "paused" });
    expect(paused).toMatchObject({ enabled: false, nextRunAt: null });

    await engineRunAutomation(deps, client, actor, { botId: "b1", id: "t1" });
    expect(runTask).toHaveBeenCalledWith(client, "a@example.test", "t1");
    await engineRemoveAutomation(deps, client, actor, { botId: "b1", id: "t1" });
    expect(deleteTask).toHaveBeenCalledWith(client, "a@example.test", "t1");

    await expect(
      engineRemoveAutomation(deps, client, actor, { botId: "b1", id: "other" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(deleteTask).toHaveBeenCalledTimes(1);
  });
});
