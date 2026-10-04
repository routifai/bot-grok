import type { PrismaClient, ThreadEvents } from "@aiden/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { failRunUnsupportedOnOmnigent, runTurnOnOmnigent } from "./gateway.js";

const {
  createOmnigentSession,
  findOmnigentAgentIdByName,
  getOmnigentSession,
  postOmnigentMessage,
  putOmnigentTimezone,
  streamOmnigentSession,
  switchOmnigentAgent,
} = vi.hoisted(() => ({
  createOmnigentSession: vi.fn(),
  findOmnigentAgentIdByName: vi.fn(),
  getOmnigentSession: vi.fn(),
  postOmnigentMessage: vi.fn(),
  putOmnigentTimezone: vi.fn(),
  streamOmnigentSession: vi.fn(),
  switchOmnigentAgent: vi.fn(),
}));

vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  createOmnigentSession,
  findOmnigentAgentIdByName,
  getOmnigentSession,
  postOmnigentMessage,
  putOmnigentTimezone,
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
    bot: {
      findUnique: vi.fn(async () => ({ computer: { homeKey: "team-space-1" } })),
    },
    user: { findUniqueOrThrow: vi.fn(async () => ({ email: "person@example.test" })) },
    task: { findUniqueOrThrow: vi.fn(async () => ({ prompt: "hello" })) },
    omnigentSession: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({
        omnigentSessionId: "conv_1",
        agentName: "nova-pi",
        runnerLocation: "computer",
      })),
      update: vi.fn(async () => ({ omnigentSessionId: "conv_1", agentName: "nova-pi" })),
    },
  };
  return { ...base, ...overrides } as unknown as PrismaClient;
}

function fakeEvents(): ThreadEvents {
  return {
    finalizeRun: vi.fn(async () => ({ continuationRunId: null })),
    claimSteering: vi.fn(async () => []),
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
    // Default: a reused session already has a runner bound and the Super Chat mode label, so
    // checkSessionRepair's snapshot check does not force an unwanted recreate in tests that
    // don't care about that path.
    getOmnigentSession.mockResolvedValue({
      id: "conv_existing",
      host_id: "host_1",
      labels: { "omnigent.context.mode": "superside-chat" },
    });
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

  it("runs a skill test run as an ordinary engine turn", async () => {
    const prisma = fakePrisma({
      run: {
        findUnique: vi.fn(async () => ({ ...RUN, trigger: "skill" })),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
    });
    const result = await runTurnOnOmnigent(
      { prisma, events: fakeEvents(), ...DEPS_BASE },
      "run-1",
      "worker-1",
    );
    expect(result).toBe(true);
  });

  it("fails a run the engine cannot handle once, without touching the engine", async () => {
    const prisma = fakePrisma({
      run: {
        findUnique: vi.fn(async () => ({ ...RUN, trigger: "routine" })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    });
    const events = fakeEvents();
    await failRunUnsupportedOnOmnigent({ prisma, events, ...DEPS_BASE }, "run-1", "worker-1");
    expect(events.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "failed", error: expect.stringContaining("routine") }),
    );
    expect(createOmnigentSession).not.toHaveBeenCalled();
  });

  it("returns false for a Goal-log thread", async () => {
    const prisma = fakePrisma({
      thread: { findUnique: vi.fn(async () => ({ botId: "bot-1", goalId: "goal-1" })) },
    });
    const events = fakeEvents();
    const result = await runTurnOnOmnigent({ prisma, events, ...DEPS_BASE }, "run-1", "worker-1");
    expect(result).toBe(false);
  });

  it("syncs the person's timezone to the engine before the turn, and survives a failure", async () => {
    findOmnigentAgentIdByName.mockResolvedValue("ag_1");
    createOmnigentSession.mockResolvedValue({ id: "conv_1", status: "running" });
    putOmnigentTimezone.mockRejectedValue(new Error("engine down"));
    streamOmnigentSession.mockReturnValue(
      eventsFrom([
        {
          type: "response.completed",
          response: {
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Hi" }],
              },
            ],
          },
        },
      ]),
    );
    const prisma = fakePrisma({
      user: {
        findUniqueOrThrow: vi.fn(async () => ({
          email: "person@example.test",
          timezone: "America/Toronto",
        })),
      },
    });
    const events = fakeEvents();
    await runTurnOnOmnigent({ prisma, events, ...DEPS_BASE }, "run-1", "worker-1");
    expect(putOmnigentTimezone).toHaveBeenCalledWith(
      DEPS_BASE.client,
      "person@example.test",
      "America/Toronto",
    );
    expect(postOmnigentMessage).toHaveBeenCalled();
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
        // The "computer" runner location (the default) binds via Omnigent's own managed-sandbox
        // provisioning, never by a caller-supplied host_id — otherwise the session never gets a
        // runner bound and every turn fails with "no runner bound for session".
        hostType: "managed",
        sandboxProvider: "computer",
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

  it("sends the person's exact queued messages, never the steering placeholder", async () => {
    findOmnigentAgentIdByName.mockResolvedValue("ag_1");
    createOmnigentSession.mockResolvedValue({ id: "conv_1", status: "running" });
    streamOmnigentSession.mockReturnValue(
      eventsFrom([{ type: "response.completed", response: { output: [] } }]),
    );
    const prisma = fakePrisma({
      task: {
        findUniqueOrThrow: vi.fn(async () => ({
          prompt: "Respond to the user's steering context.",
        })),
      },
    });
    const events = fakeEvents();
    const first = "Quick context about me: I'm a product manager building an AI assistant.";
    const second = "Also: I care about agent safety.";
    vi.mocked(events.claimSteering).mockResolvedValue([
      { id: "s1", messageId: "m1", text: first, blocks: [] },
      { id: "s2", messageId: "m2", text: second, blocks: [] },
    ]);
    await runTurnOnOmnigent({ prisma, events, ...DEPS_BASE }, "run-1", "worker-1");
    expect(events.claimSteering).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", threadId: "thread-1", seenIds: [] }),
    );
    expect(postOmnigentMessage).toHaveBeenCalledWith(
      DEPS_BASE.client,
      "person@example.test",
      "conv_1",
      `${first}\n\n${second}`,
    );
  });

  it("fails the turn rather than sending the placeholder when no steering text exists", async () => {
    findOmnigentAgentIdByName.mockResolvedValue("ag_1");
    createOmnigentSession.mockResolvedValue({ id: "conv_1", status: "running" });
    const prisma = fakePrisma({
      task: {
        findUniqueOrThrow: vi.fn(async () => ({
          prompt: "Respond to the user's steering context.",
        })),
      },
    });
    const events = fakeEvents();
    await runTurnOnOmnigent({ prisma, events, ...DEPS_BASE }, "run-1", "worker-1");
    expect(postOmnigentMessage).not.toHaveBeenCalled();
    expect(events.finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
  });

  it("records the turn's last item id so the mirror job never re-delivers it", async () => {
    findOmnigentAgentIdByName.mockResolvedValue("ag_1");
    createOmnigentSession.mockResolvedValue({ id: "conv_1", status: "running" });
    streamOmnigentSession.mockReturnValue(
      eventsFrom([
        {
          type: "response.completed",
          response: {
            output: [
              {
                id: "item_abc",
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
    await runTurnOnOmnigent({ prisma, events, ...DEPS_BASE }, "run-1", "worker-1");

    expect(prisma.omnigentSession.update).toHaveBeenCalledWith({
      where: { botId: "bot-1" },
      data: { lastMirroredItemId: "item_abc" },
    });
  });

  it("takes the reply from the last assistant output item when response.completed has no output", async () => {
    findOmnigentAgentIdByName.mockResolvedValue("ag_1");
    createOmnigentSession.mockResolvedValue({ id: "conv_1", status: "running" });
    const assistant = (text: string) => ({
      type: "response.output_item.done",
      item: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
    });
    streamOmnigentSession.mockReturnValue(
      eventsFrom([
        assistant("Let me check."),
        { type: "response.output_item.done", item: { type: "function_call", name: "web_search" } },
        assistant("Here is the answer."),
        { type: "response.completed", response: { output: [] } },
      ]),
    );

    const events = fakeEvents();
    await runTurnOnOmnigent({ prisma: fakePrisma(), events, ...DEPS_BASE }, "run-1", "worker-1");

    expect(events.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "completed",
        blocks: [{ kind: "text", text: "Here is the answer." }],
      }),
    );
  });

  it("fails the run with the reason Omnigent nests under response.error", async () => {
    findOmnigentAgentIdByName.mockResolvedValue("ag_1");
    createOmnigentSession.mockResolvedValue({ id: "conv_1", status: "running" });
    streamOmnigentSession.mockReturnValue(
      eventsFrom([
        {
          type: "response.failed",
          response: { error: { code: "RuntimeError", message: "provider authentication failed" } },
        },
      ]),
    );

    const events = fakeEvents();
    await runTurnOnOmnigent({ prisma: fakePrisma(), events, ...DEPS_BASE }, "run-1", "worker-1");

    expect(events.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "failed", error: "provider authentication failed" }),
    );
  });

  it("reuses an existing Omnigent session without resolving an agent id again", async () => {
    const prisma = fakePrisma({
      omnigentSession: {
        findUnique: vi.fn(async () => ({
          botId: "bot-1",
          omnigentSessionId: "conv_existing",
          agentName: "nova-pi",
          runnerLocation: "computer",
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
          runnerLocation: "computer",
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

  describe("agent switching", () => {
    function prismaWithSession(agentName: string) {
      const updateMock = vi.fn(async () => ({}));
      const prisma = fakePrisma({
        omnigentSession: {
          findUnique: vi.fn(async () => ({
            botId: "bot-1",
            omnigentSessionId: "conv_existing",
            agentName,
            runnerLocation: "computer",
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

    it("switches the Omnigent agent when the configured agent differs from the session's recorded agent", async () => {
      const { prisma, updateMock } = prismaWithSession("nova-pi");
      findOmnigentAgentIdByName.mockResolvedValue("ag_claude");
      switchOmnigentAgent.mockResolvedValue({ id: "conv_existing", status: "idle" });
      const events = fakeEvents();

      const result = await runTurnOnOmnigent(
        { prisma, events, ...DEPS_BASE, agentName: "nova-claude" },
        "run-1",
        "worker-1",
      );

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

    it("does not switch when the configured agent already matches the session's recorded agent", async () => {
      const { prisma, updateMock } = prismaWithSession("nova-claude");
      const events = fakeEvents();

      await runTurnOnOmnigent(
        { prisma, events, ...DEPS_BASE, agentName: "nova-claude" },
        "run-1",
        "worker-1",
      );

      expect(switchOmnigentAgent).not.toHaveBeenCalled();
      // The session row is still touched once, to bump updatedAt (keeps an active Super Chat
      // inside the mirror job's lookback window) — but never with an agentName write, which
      // only switch-agent persistence does.
      expect(updateMock).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ agentName: expect.anything() }),
        }),
      );
    });

    it("continues the turn on the current agent and leaves the record untouched when switch-agent fails", async () => {
      const { prisma, updateMock } = prismaWithSession("nova-pi");
      findOmnigentAgentIdByName.mockResolvedValue("ag_claude");
      switchOmnigentAgent.mockRejectedValue(new Error("Session is busy"));
      const events = fakeEvents();

      const result = await runTurnOnOmnigent(
        { prisma, events, ...DEPS_BASE, agentName: "nova-claude" },
        "run-1",
        "worker-1",
      );

      expect(result).toBe(true);
      // leaves the record untouched (but still bumped for updatedAt, see above) when
      // switch-agent fails: the agentName write never happens.
      expect(updateMock).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ agentName: expect.anything() }),
        }),
      );
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

  describe("runner binding", () => {
    beforeEach(() => {
      streamOmnigentSession.mockReturnValue(
        eventsFrom([{ type: "response.completed", response: { output: [] } }]),
      );
      findOmnigentAgentIdByName.mockResolvedValue("ag_1");
      createOmnigentSession.mockResolvedValue({ id: "conv_new", status: "running" });
    });

    it("repairs an existing session that never got a runner bound", async () => {
      const upsertMock = vi.fn(async () => ({
        omnigentSessionId: "conv_new",
        agentName: "nova-pi",
        runnerLocation: "computer",
      }));
      const prisma = fakePrisma({
        omnigentSession: {
          findUnique: vi.fn(async () => ({
            botId: "bot-1",
            omnigentSessionId: "conv_unbound",
            agentName: "nova-pi",
            runnerLocation: "computer",
          })),
          upsert: upsertMock,
          update: vi.fn(),
        },
      });
      getOmnigentSession.mockResolvedValue({ id: "conv_unbound", host_id: null });
      const events = fakeEvents();

      const result = await runTurnOnOmnigent({ prisma, events, ...DEPS_BASE }, "run-1", "worker-1");

      expect(result).toBe(true);
      expect(createOmnigentSession).toHaveBeenCalledWith(
        DEPS_BASE.client,
        "person@example.test",
        expect.objectContaining({
          hostType: "managed",
          sandboxProvider: "computer",
          // Lands the runner on the same computer Nova shows the person.
          labels: expect.objectContaining({ "nova.computer": "team-space-1" }),
        }),
      );
      expect(upsertMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { botId: "bot-1" },
          // The fresh Omnigent session has its own item id space (docs/super-chat/WIRING.md
          // review item 1): a stale cursor into the old one must not carry over.
          create: expect.objectContaining({
            omnigentSessionId: "conv_new",
            lastMirroredItemId: null,
          }),
          update: expect.objectContaining({
            omnigentSessionId: "conv_new",
            lastMirroredItemId: null,
          }),
        }),
      );
      expect(postOmnigentMessage).toHaveBeenCalledWith(
        DEPS_BASE.client,
        "person@example.test",
        "conv_new",
        "hello",
      );
    });

    it("recreates the session when the engine no longer has it", async () => {
      const upsertMock = vi.fn(async () => ({
        omnigentSessionId: "conv_new",
        agentName: "nova-claude",
        runnerLocation: "computer",
      }));
      const prisma = fakePrisma({
        omnigentSession: {
          findUnique: vi.fn(async () => ({
            botId: "bot-1",
            omnigentSessionId: "conv_gone",
            agentName: "nova-claude",
            runnerLocation: "computer",
          })),
          upsert: upsertMock,
          update: vi.fn(),
        },
      });
      const { OmnigentApiError } = await import("./client.js");
      getOmnigentSession.mockRejectedValue(
        new OmnigentApiError("omnigent get session failed (404)", "not_found"),
      );

      const result = await runTurnOnOmnigent(
        { prisma, events: fakeEvents(), ...DEPS_BASE },
        "run-1",
        "worker-1",
      );

      expect(result).toBe(true);
      expect(postOmnigentMessage).toHaveBeenCalledWith(
        DEPS_BASE.client,
        "person@example.test",
        "conv_new",
        "hello",
      );
    });

    it("repairs an existing session that is missing the Super Chat mode label", async () => {
      const upsertMock = vi.fn(async () => ({
        omnigentSessionId: "conv_new",
        agentName: "nova-pi",
        runnerLocation: "computer",
      }));
      const prisma = fakePrisma({
        omnigentSession: {
          findUnique: vi.fn(async () => ({
            botId: "bot-1",
            omnigentSessionId: "conv_unlabelled",
            agentName: "nova-pi",
            runnerLocation: "computer",
          })),
          upsert: upsertMock,
          update: vi.fn(),
        },
      });
      // A pre-A1 session: a runner is bound, but it predates the superside-chat mode label.
      getOmnigentSession.mockResolvedValue({
        id: "conv_unlabelled",
        host_id: "host_1",
        labels: {},
      });
      const events = fakeEvents();

      const result = await runTurnOnOmnigent({ prisma, events, ...DEPS_BASE }, "run-1", "worker-1");

      expect(result).toBe(true);
      expect(createOmnigentSession).toHaveBeenCalledWith(
        DEPS_BASE.client,
        "person@example.test",
        expect.objectContaining({
          labels: expect.objectContaining({ "omnigent.context.mode": "superside-chat" }),
        }),
      );
      expect(upsertMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { botId: "bot-1" },
          create: expect.objectContaining({ omnigentSessionId: "conv_new" }),
        }),
      );
    });

    it("recreates a session still bound to a retired runner location without checking its health", async () => {
      const upsertMock = vi.fn(async () => ({
        omnigentSessionId: "conv_new",
        agentName: "nova-pi",
        runnerLocation: "computer",
      }));
      const prisma = fakePrisma({
        omnigentSession: {
          findUnique: vi.fn(async () => ({
            botId: "bot-1",
            omnigentSessionId: "conv_existing",
            agentName: "nova-pi",
            runnerLocation: "local",
          })),
          upsert: upsertMock,
          update: vi.fn(),
        },
      });

      const result = await runTurnOnOmnigent(
        { prisma, events: fakeEvents(), ...DEPS_BASE },
        "run-1",
        "worker-1",
      );

      expect(result).toBe(true);
      expect(getOmnigentSession).not.toHaveBeenCalled();
      expect(createOmnigentSession).toHaveBeenCalledWith(
        DEPS_BASE.client,
        "person@example.test",
        expect.objectContaining({ hostType: "managed", sandboxProvider: "computer" }),
      );
      expect(upsertMock).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ runnerLocation: "computer" }),
        }),
      );
    });
  });
});
