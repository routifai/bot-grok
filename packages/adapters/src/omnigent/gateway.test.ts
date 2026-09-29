import type { PrismaClient, ThreadEvents } from "@aiden/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runTurnOnOmnigent } from "./gateway.js";

const {
  createOmnigentSession,
  findOmnigentAgentIdByName,
  postOmnigentMessage,
  streamOmnigentSession,
  switchOmnigentAgent,
} = vi.hoisted(() => ({
  createOmnigentSession: vi.fn(),
  findOmnigentAgentIdByName: vi.fn(),
  postOmnigentMessage: vi.fn(),
  streamOmnigentSession: vi.fn(),
  switchOmnigentAgent: vi.fn(),
}));

vi.mock("./client.js", () => ({
  createOmnigentSession,
  findOmnigentAgentIdByName,
  postOmnigentMessage,
  streamOmnigentSession,
  switchOmnigentAgent,
}));

const RUN = {
  id: "run-1",
  status: "queued",
  trigger: "user",
  leaseFence: 0,
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  threadId: "thread-1",
  taskId: "task-1",
};

async function* eventsFrom(events: Array<Record<string, unknown>>) {
  for (const event of events) yield event;
}

function fakePrisma(overrides: Record<string, unknown> = {}): PrismaClient {
  const base = {
    run: {
      findUnique: vi.fn(async () => RUN),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: {
      findUnique: vi.fn(async () => ({ botId: "bot-1", goalId: null })),
    },
    attempt: { create: vi.fn(async () => ({ id: "attempt-1" })) },
    bot: { findUniqueOrThrow: vi.fn(async () => ({ id: "bot-1", museHarness: null })) },
    user: { findUniqueOrThrow: vi.fn(async () => ({ email: "person@example.test" })) },
    task: { findUniqueOrThrow: vi.fn(async () => ({ prompt: "hello" })) },
    omnigentSession: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({ omnigentSessionId: "conv_1", agentName: "nova-pi" })),
      update: vi.fn(async () => ({ omnigentSessionId: "conv_1", agentName: "nova-pi" })),
    },
  };
  return { ...base, ...overrides } as unknown as PrismaClient;
}

function fakeEvents(): ThreadEvents {
  return {
    finalizeRun: vi.fn(async () => ({ continuationRunId: null })),
  } as unknown as ThreadEvents;
}

const DEPS_BASE = {
  client: { baseUrl: "http://omnigent.test", proxySecret: "secret" },
  secrets: [],
  agentName: "nova-pi",
};

describe("runTurnOnOmnigent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns false and touches nothing for a non-user trigger", async () => {
    const prisma = fakePrisma({
      run: { findUnique: vi.fn(async () => ({ ...RUN, trigger: "routine" })) },
    });
    const events = fakeEvents();
    const result = await runTurnOnOmnigent({ prisma, events, ...DEPS_BASE }, "run-1", "worker-1");
    expect(result).toBe(false);
    expect(events.finalizeRun).not.toHaveBeenCalled();
  });

  it("returns false for a Goal-log thread", async () => {
    const prisma = fakePrisma({
      thread: { findUnique: vi.fn(async () => ({ botId: "bot-1", goalId: "goal-1" })) },
    });
    const events = fakeEvents();
    const result = await runTurnOnOmnigent({ prisma, events, ...DEPS_BASE }, "run-1", "worker-1");
    expect(result).toBe(false);
  });

  it("claims, creates a session, posts the turn, and finalizes on response.completed", async () => {
    findOmnigentAgentIdByName.mockResolvedValue("ag_1");
    createOmnigentSession.mockResolvedValue({ id: "conv_1", status: "running" });
    streamOmnigentSession.mockReturnValue(
      eventsFrom([
        { type: "session.status", data: { status: "running" } },
        {
          type: "response.completed",
          response: {
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Hello there" }],
              },
            ],
          },
        },
      ]),
    );

    const prisma = fakePrisma();
    const events = fakeEvents();
    const result = await runTurnOnOmnigent({ prisma, events, ...DEPS_BASE }, "run-1", "worker-1");

    expect(result).toBe(true);
    expect(findOmnigentAgentIdByName).toHaveBeenCalledWith(
      DEPS_BASE.client,
      "person@example.test",
      "nova-pi",
    );
    expect(createOmnigentSession).toHaveBeenCalledWith(
      DEPS_BASE.client,
      "person@example.test",
      expect.objectContaining({
        agentId: "ag_1",
        labels: expect.objectContaining({
          "nova.user": "user-1",
          "nova.space": "space-1",
          "nova.bot": "bot-1",
          "nova.scope": "private",
        }),
      }),
    );
    expect(postOmnigentMessage).toHaveBeenCalledWith(
      DEPS_BASE.client,
      "person@example.test",
      "conv_1",
      "hello",
    );
    expect(events.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "completed",
        blocks: [{ kind: "text", text: "Hello there" }],
        runId: "run-1",
      }),
    );
  });

  it("reuses an existing Omnigent session without resolving an agent id again", async () => {
    const prisma = fakePrisma({
      omnigentSession: {
        findUnique: vi.fn(async () => ({
          botId: "bot-1",
          omnigentSessionId: "conv_existing",
          agentName: "nova-pi",
        })),
        upsert: vi.fn(),
        update: vi.fn(),
      },
    });
    streamOmnigentSession.mockReturnValue(
      eventsFrom([
        {
          type: "response.completed",
          response: { output: [] },
        },
      ]),
    );
    const events = fakeEvents();
    await runTurnOnOmnigent({ prisma, events, ...DEPS_BASE }, "run-1", "worker-1");

    expect(findOmnigentAgentIdByName).not.toHaveBeenCalled();
    expect(createOmnigentSession).not.toHaveBeenCalled();
    expect(postOmnigentMessage).toHaveBeenCalledWith(
      DEPS_BASE.client,
      "person@example.test",
      "conv_existing",
      "hello",
    );
    expect(switchOmnigentAgent).not.toHaveBeenCalled();
  });

  it("finalizes as failed when Omnigent reports response.failed", async () => {
    const prisma = fakePrisma({
      omnigentSession: {
        findUnique: vi.fn(async () => ({
          botId: "bot-1",
          omnigentSessionId: "conv_existing",
          agentName: "nova-pi",
        })),
        upsert: vi.fn(),
        update: vi.fn(),
      },
    });
    streamOmnigentSession.mockReturnValue(
      eventsFrom([{ type: "response.failed", error: { message: "boom" } }]),
    );
    const events = fakeEvents();
    const result = await runTurnOnOmnigent({ prisma, events, ...DEPS_BASE }, "run-1", "worker-1");

    expect(result).toBe(true);
    expect(events.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "failed", error: "boom" }),
    );
  });

  it("returns true without acting again when the lease race is lost", async () => {
    const prisma = fakePrisma({
      run: {
        findUnique: vi.fn(async () => RUN),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
    });
    const events = fakeEvents();
    const result = await runTurnOnOmnigent({ prisma, events, ...DEPS_BASE }, "run-1", "worker-1");
    expect(result).toBe(true);
    expect(events.finalizeRun).not.toHaveBeenCalled();
  });

  describe("harness switching", () => {
    function prismaWithSession(agentName: string, museHarness: string | null) {
      const updateMock = vi.fn(async () => ({}));
      const prisma = fakePrisma({
        bot: { findUniqueOrThrow: vi.fn(async () => ({ id: "bot-1", museHarness })) },
        omnigentSession: {
          findUnique: vi.fn(async () => ({
            botId: "bot-1",
            omnigentSessionId: "conv_existing",
            agentName,
          })),
          upsert: vi.fn(),
          update: updateMock,
        },
      });
      return { prisma, updateMock };
    }

    beforeEach(() => {
      streamOmnigentSession.mockReturnValue(
        eventsFrom([{ type: "response.completed", response: { output: [] } }]),
      );
    });

    it("switches the Omnigent agent when the bot's chosen harness differs from the session's recorded agent", async () => {
      const { prisma, updateMock } = prismaWithSession("nova-pi", "claude");
      findOmnigentAgentIdByName.mockResolvedValue("ag_claude");
      switchOmnigentAgent.mockResolvedValue({ id: "conv_existing", status: "idle" });
      const events = fakeEvents();

      const result = await runTurnOnOmnigent({ prisma, events, ...DEPS_BASE }, "run-1", "worker-1");

      expect(result).toBe(true);
      expect(findOmnigentAgentIdByName).toHaveBeenCalledWith(
        DEPS_BASE.client,
        "person@example.test",
        "nova-claude",
      );
      expect(switchOmnigentAgent).toHaveBeenCalledWith(
        DEPS_BASE.client,
        "person@example.test",
        "conv_existing",
        "ag_claude",
      );
      expect(updateMock).toHaveBeenCalledWith({
        where: { botId: "bot-1" },
        data: { agentName: "nova-claude" },
      });
      expect(events.finalizeRun).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "completed" }),
      );
    });

    it("does not switch when the resolved harness already matches the session's recorded agent", async () => {
      const { prisma, updateMock } = prismaWithSession("nova-pi", null);
      const events = fakeEvents();

      await runTurnOnOmnigent({ prisma, events, ...DEPS_BASE }, "run-1", "worker-1");

      expect(switchOmnigentAgent).not.toHaveBeenCalled();
      expect(updateMock).not.toHaveBeenCalled();
    });

    it("continues the turn on the current agent and leaves the record untouched when switch-agent fails", async () => {
      const { prisma, updateMock } = prismaWithSession("nova-pi", "claude");
      findOmnigentAgentIdByName.mockResolvedValue("ag_claude");
      switchOmnigentAgent.mockRejectedValue(new Error("Session is busy"));
      const events = fakeEvents();

      const result = await runTurnOnOmnigent({ prisma, events, ...DEPS_BASE }, "run-1", "worker-1");

      expect(result).toBe(true);
      expect(updateMock).not.toHaveBeenCalled();
      expect(postOmnigentMessage).toHaveBeenCalledWith(
        DEPS_BASE.client,
        "person@example.test",
        "conv_existing",
        "hello",
      );
      expect(events.finalizeRun).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "completed" }),
      );
    });
  });
});
