import type { PrismaClient, ThreadEvents } from "@nova/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OmnigentApiError } from "./client.js";
import {
  COMPUTER_START_FAILED_MESSAGE,
  ENGINE_FAILED_MESSAGE,
  ENGINE_INTERRUPTED_MESSAGE,
  failRunUnsupportedOnOmnigent,
  publicRunError,
  readTurnAttachmentContext,
  readTurnImages,
  runTurnOnOmnigent,
} from "./gateway.js";

const {
  adoptOmnigentMuse,
  getOmnigentMuse,
  ingestOmnigentKnowledge,
  postOmnigentMessage,
  putOmnigentTimezone,
  readOmnigentFile,
  streamOmnigentSession,
} = vi.hoisted(() => ({
  adoptOmnigentMuse: vi.fn(),
  getOmnigentMuse: vi.fn(),
  ingestOmnigentKnowledge: vi.fn(),
  postOmnigentMessage: vi.fn(),
  putOmnigentTimezone: vi.fn(),
  readOmnigentFile: vi.fn(),
  streamOmnigentSession: vi.fn(),
}));

vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  adoptOmnigentMuse,
  getOmnigentMuse,
  ingestOmnigentKnowledge,
  postOmnigentMessage,
  putOmnigentTimezone,
  readOmnigentFile,
  streamOmnigentSession,
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
      upsert: vi.fn(async () => ({})),
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

const DEPS_BASE = { client: { baseUrl: "http://omnigent.test", proxySecret: "secret" } };
/** The connection bound to the run's space, as every engine call of the turn sends it. */
const CLIENT = { ...DEPS_BASE.client, tenant: "space-1" };

describe("runTurnOnOmnigent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getOmnigentMuse.mockResolvedValue({ session_id: "conv_1", agent: "superchat", created: true });
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
    expect(getOmnigentMuse).not.toHaveBeenCalled();
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
      CLIENT,
      "person@example.test",
      "America/Toronto",
    );
    expect(postOmnigentMessage).toHaveBeenCalled();
  });

  it("claims, resolves the Muse on the engine, posts the turn, and finalizes on response.completed", async () => {
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
    // A Muse with no Conversation yet: nothing to adopt, the engine finds or creates it.
    expect(adoptOmnigentMuse).not.toHaveBeenCalled();
    expect(getOmnigentMuse).toHaveBeenCalledWith(CLIENT, "person@example.test");
    expect(prisma.omnigentSession.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { botId: "bot-1" },
        create: expect.objectContaining({
          omnigentSessionId: "conv_1",
          agentName: "superchat",
          engineAdoptedAt: expect.any(Date),
        }),
      }),
    );
    expect(postOmnigentMessage).toHaveBeenCalledWith(
      CLIENT,
      "person@example.test",
      "conv_1",
      "hello",
    );
    expect(events.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "completed",
        // The reply is the engine's transcript, never a Nova message.
        blocks: [],
        runId: "run-1",
      }),
    );
  });

  it("sends the person's exact queued messages, never the steering placeholder", async () => {
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
      CLIENT,
      "person@example.test",
      "conv_1",
      `${first}\n\n${second}`,
    );
  });

  it("fails the turn rather than sending the placeholder when no steering text exists", async () => {
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

  it("finishes the run on response.completed whatever the stream carried", async () => {
    streamOmnigentSession.mockReturnValue(
      eventsFrom([
        {
          type: "response.output_item.done",
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Let me check." }],
          },
        },
        { type: "response.completed", response: { output: [] } },
      ]),
    );

    const events = fakeEvents();
    await runTurnOnOmnigent({ prisma: fakePrisma(), events, ...DEPS_BASE }, "run-1", "worker-1");

    expect(events.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "completed", blocks: [] }),
    );
    expect(events.finalizeRun).not.toHaveBeenCalledWith(
      expect.objectContaining({ markUnread: true }),
    );
  });

  it("fails the run with the reason Omnigent nests under response.error", async () => {
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

  it("finalizes as failed when Omnigent reports response.failed", async () => {
    const prisma = fakePrisma({
      omnigentSession: {
        findUnique: vi.fn(async () => ({
          botId: "bot-1",
          omnigentSessionId: "conv_1",
          engineAdoptedAt: new Date(0),
        })),
        upsert: vi.fn(),
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

  it.each([
    ["a failed launch stage", { type: "session.sandbox_status", stage: "failed", error: "x" }],
    [
      "a failed session with runner_unavailable",
      {
        type: "session.status",
        status: "failed",
        error: { code: "runner_unavailable", message: "managed host did not come online" },
      },
    ],
    [
      "a failed response with runner_unavailable",
      {
        type: "response.failed",
        response: { error: { code: "runner_unavailable", message: "x" } },
      },
    ],
  ])("ends the turn with a calm Computer note on %s", async (_name, event) => {
    streamOmnigentSession.mockReturnValue(
      eventsFrom([{ type: "session.sandbox_status", stage: "starting" }, event]),
    );
    const events = fakeEvents();
    await runTurnOnOmnigent({ prisma: fakePrisma(), events, ...DEPS_BASE }, "run-1", "worker-1");

    expect(events.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "failed", error: COMPUTER_START_FAILED_MESSAGE }),
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

  describe("Muse resolution", () => {
    const completed = () =>
      streamOmnigentSession.mockReturnValue(
        eventsFrom([{ type: "response.completed", response: { output: [] } }]),
      );
    function prismaWithRow(row: Record<string, unknown>) {
      return fakePrisma({
        omnigentSession: {
          findUnique: vi.fn(async () => ({ botId: "bot-1", ...row })),
          upsert: vi.fn(async () => ({})),
        },
      });
    }

    it("adopts an existing Conversation once, so the person keeps it", async () => {
      completed();
      adoptOmnigentMuse.mockResolvedValue({ session_id: "conv_old", agent: "nova-claude" });
      getOmnigentMuse.mockResolvedValue({
        session_id: "conv_old",
        agent: "nova-claude",
        created: false,
      });
      const prisma = prismaWithRow({ omnigentSessionId: "conv_old", engineAdoptedAt: null });
      const events = fakeEvents();
      await runTurnOnOmnigent({ prisma, events, ...DEPS_BASE }, "run-1", "worker-1");

      expect(adoptOmnigentMuse).toHaveBeenCalledWith(CLIENT, "person@example.test", "conv_old");
      expect(vi.mocked(adoptOmnigentMuse).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(getOmnigentMuse).mock.invocationCallOrder[0] ?? 0,
      );
      expect(prisma.omnigentSession.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            omnigentSessionId: "conv_old",
            engineAdoptedAt: expect.any(Date),
          }),
        }),
      );
      expect(postOmnigentMessage).toHaveBeenCalledWith(
        CLIENT,
        "person@example.test",
        "conv_old",
        "hello",
      );
      expect(events.finalizeRun).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "completed" }),
      );
    });

    it("does not adopt again once the row records it", async () => {
      completed();
      const adoptedAt = new Date(0);
      const prisma = prismaWithRow({ omnigentSessionId: "conv_1", engineAdoptedAt: adoptedAt });
      await runTurnOnOmnigent({ prisma, events: fakeEvents(), ...DEPS_BASE }, "run-1", "worker-1");

      expect(adoptOmnigentMuse).not.toHaveBeenCalled();
      expect(prisma.omnigentSession.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({ engineAdoptedAt: adoptedAt }),
        }),
      );
    });

    it("treats muse_already_set as done when the engine's Muse is the same Conversation", async () => {
      completed();
      adoptOmnigentMuse.mockRejectedValue(new OmnigentApiError("409", "muse_already_set"));
      getOmnigentMuse.mockResolvedValue({ session_id: "conv_old", agent: "x", created: false });
      const prisma = prismaWithRow({ omnigentSessionId: "conv_old", engineAdoptedAt: null });
      const events = fakeEvents();
      await runTurnOnOmnigent({ prisma, events, ...DEPS_BASE }, "run-1", "worker-1");

      expect(postOmnigentMessage).toHaveBeenCalledWith(
        CLIENT,
        "person@example.test",
        "conv_old",
        "hello",
      );
    });

    it("never replaces the Conversation when another Muse is already set: the turn fails", async () => {
      adoptOmnigentMuse.mockRejectedValue(new OmnigentApiError("409", "muse_already_set"));
      getOmnigentMuse.mockResolvedValue({ session_id: "conv_other", agent: "x", created: false });
      const prisma = prismaWithRow({ omnigentSessionId: "conv_old", engineAdoptedAt: null });
      const events = fakeEvents();
      await runTurnOnOmnigent({ prisma, events, ...DEPS_BASE }, "run-1", "worker-1");

      expect(prisma.omnigentSession.upsert).not.toHaveBeenCalled();
      expect(postOmnigentMessage).not.toHaveBeenCalled();
      expect(events.finalizeRun).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: "failed",
          error: "You already have a Conversation here.",
        }),
      );
    });

    it("lets the engine's Muse take over when the old session is gone", async () => {
      completed();
      adoptOmnigentMuse.mockRejectedValue(new OmnigentApiError("404", "not_found"));
      const prisma = prismaWithRow({ omnigentSessionId: "conv_gone", engineAdoptedAt: null });
      await runTurnOnOmnigent({ prisma, events: fakeEvents(), ...DEPS_BASE }, "run-1", "worker-1");

      expect(postOmnigentMessage).toHaveBeenCalledWith(
        CLIENT,
        "person@example.test",
        "conv_1",
        "hello",
      );
    });

    it("says chat is unavailable when the engine has no Muse agent configured", async () => {
      getOmnigentMuse.mockRejectedValue(new OmnigentApiError("503", "superchat_not_configured"));
      const events = fakeEvents();
      await runTurnOnOmnigent({ prisma: fakePrisma(), events, ...DEPS_BASE }, "run-1", "worker-1");

      expect(events.finalizeRun).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "failed", error: "Chat is not available right now." }),
      );
    });

    it("never shows an engine API failure's status or body", async () => {
      getOmnigentMuse.mockRejectedValue(
        new OmnigentApiError(
          'omnigent get muse failed (400): {"error":{"code":"invalid_input","message":"Unresolved environment variable"}}',
          "invalid_input",
        ),
      );
      const events = fakeEvents();
      await runTurnOnOmnigent({ prisma: fakePrisma(), events, ...DEPS_BASE }, "run-1", "worker-1");

      expect(events.finalizeRun).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: "failed",
          error: "Nova couldn't start. Try again in a moment.",
        }),
      );
    });
  });
});

/** A session stream the test feeds by hand, so a message can arrive while the turn runs. */
function liveStream() {
  const queue: Array<Record<string, unknown>> = [];
  let waiting: ((result: IteratorResult<Record<string, unknown>>) => void) | undefined;
  return {
    push(event: Record<string, unknown>) {
      if (waiting) {
        const resolve = waiting;
        waiting = undefined;
        resolve({ done: false, value: event });
      } else queue.push(event);
    },
    [Symbol.asyncIterator]() {
      return this;
    },
    next(): Promise<IteratorResult<Record<string, unknown>>> {
      const event = queue.shift();
      if (event) return Promise.resolve({ done: false, value: event });
      return new Promise((resolve) => {
        waiting = resolve;
      });
    },
    async return() {
      waiting?.({ done: true, value: undefined });
      return { done: true as const, value: undefined };
    },
  };
}

const delivery = (itemId: string, delivered: string) => ({
  type: "session.input.delivery",
  data: { item_id: itemId, delivered },
});

describe("a message the person sends while the turn runs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    getOmnigentMuse.mockResolvedValue({ session_id: "conv_1", agent: "superchat", created: true });
  });
  afterEach(() => vi.useRealTimers());

  function setup(steering: Array<Array<{ id: string; text: string }>>) {
    const stream = liveStream();
    streamOmnigentSession.mockReturnValue(stream);
    const batches = [...steering];
    const steeringMessage = {
      findFirst: vi.fn(async () => (batches.length ? { id: "pending" } : null)),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    };
    const prisma = fakePrisma({ steeringMessage });
    const events = fakeEvents();
    // The first claim is the turn's own (nothing yet); later ones are the polls.
    vi.mocked(events.claimSteering)
      .mockResolvedValueOnce([])
      .mockImplementation(async () =>
        (batches.shift() ?? []).map((item) => ({ ...item, messageId: "m", blocks: [] })),
      );
    const done = runTurnOnOmnigent({ prisma, events, ...DEPS_BASE }, "run-1", "worker-1");
    return { stream, prisma, events, steeringMessage, done };
  }

  it("is posted to the engine as the turn runs, once, and the run ends with the turn", async () => {
    const { stream, events, steeringMessage, done } = setup([
      [{ id: "s1", text: "just redo the deck again" }],
    ]);
    postOmnigentMessage.mockResolvedValueOnce(undefined).mockResolvedValueOnce("msg_2");

    await vi.advanceTimersByTimeAsync(1_000);

    expect(postOmnigentMessage).toHaveBeenCalledTimes(2);
    expect(postOmnigentMessage).toHaveBeenLastCalledWith(
      CLIENT,
      "person@example.test",
      "conv_1",
      "just redo the deck again",
    );
    // The engine has it: a continuation must not send it again.
    expect(steeringMessage.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["s1"] } } });
    expect(events.finalizeRun).not.toHaveBeenCalled();

    stream.push(delivery("msg_2", "steer"));
    stream.push({ type: "response.completed", response: { output: [] } });
    expect(await done).toBe(true);

    expect(postOmnigentMessage).toHaveBeenCalledTimes(2); // one turn, no resend
    expect(events.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "completed" }),
    );
    const polls = vi.mocked(events.claimSteering).mock.calls.map(([input]) => input.seenIds);
    expect(polls.at(-1)).toEqual(["s1"]); // a claimed message is never claimed twice
  });

  it("keeps the run working until the turn of a message the engine queued has finished", async () => {
    const { stream, events, done } = setup([[{ id: "s1", text: "and make it blue" }]]);
    postOmnigentMessage.mockResolvedValueOnce(undefined).mockResolvedValueOnce("msg_2");
    await vi.advanceTimersByTimeAsync(1_000);

    stream.push(delivery("msg_2", "queued"));
    stream.push({ type: "response.completed", response: { output: [] } });
    await vi.advanceTimersByTimeAsync(10_000);
    // The first turn is over, the queued one has not run yet: still working.
    expect(events.finalizeRun).not.toHaveBeenCalled();

    stream.push(delivery("msg_2", "turn"));
    stream.push({ type: "response.created", response: { id: "resp_2" } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events.finalizeRun).not.toHaveBeenCalled(); // its turn is running

    stream.push({ type: "response.completed", response: { output: [] } });
    expect(await done).toBe(true);
    expect(events.finalizeRun).toHaveBeenCalledTimes(1);
    expect(events.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "completed" }),
    );
  });

  it("is not waited on when the engine reported it before the post answered", async () => {
    const { stream, events, done } = setup([[{ id: "s1", text: "also blue" }]]);
    let answer: (id: string) => void = () => undefined;
    postOmnigentMessage
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => new Promise<string>((resolve) => (answer = resolve)));
    await vi.advanceTimersByTimeAsync(1_000);

    stream.push(delivery("msg_2", "steer")); // beats the HTTP response
    await vi.advanceTimersByTimeAsync(0);
    answer("msg_2");
    await vi.advanceTimersByTimeAsync(0);
    stream.push({ type: "response.completed", response: { output: [] } });

    expect(await done).toBe(true);
    expect(events.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "completed" }),
    );
  });

  it("ends the run after a short wait when an engine never reports what became of it", async () => {
    const { stream, events, done } = setup([[{ id: "s1", text: "also blue" }]]);
    postOmnigentMessage.mockResolvedValueOnce(undefined).mockResolvedValueOnce("msg_2");
    await vi.advanceTimersByTimeAsync(1_000);

    stream.push({ type: "response.completed", response: { output: [] } });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(events.finalizeRun).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_500);

    expect(await done).toBe(true);
    expect(events.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "completed" }),
    );
  });

  it("fails the run, keeping the message for a retry, when the engine cannot be reached", async () => {
    const { stream, events, steeringMessage, done } = setup([[{ id: "s1", text: "also blue" }]]);
    postOmnigentMessage
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("fetch failed"));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await done).toBe(true);
    expect(events.finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
    expect(steeringMessage.deleteMany).not.toHaveBeenCalled();
    stream.push({ type: "response.completed", response: { output: [] } });
  });
});

describe("publicRunError", () => {
  it("says the turn was interrupted when the engine connection drops", () => {
    expect(publicRunError(new TypeError("terminated"))).toBe(ENGINE_INTERRUPTED_MESSAGE);
    expect(publicRunError(new TypeError("fetch failed"))).toBe(ENGINE_INTERRUPTED_MESSAGE);
    const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    expect(publicRunError(reset)).toBe(ENGINE_INTERRUPTED_MESSAGE);
  });

  it("never shows a raw error message", () => {
    expect(publicRunError(new Error("steering continuation has no user message text"))).toBe(
      ENGINE_FAILED_MESSAGE,
    );
    expect(publicRunError("boom")).toBe(ENGINE_FAILED_MESSAGE);
  });
});

describe("attached images", () => {
  const png = new Uint8Array([137, 80, 78, 71]);
  const ref = (path: string, mime: string, size = 4) =>
    `Attached file in your workspace: ${path} (${mime}, ${size} bytes)`;

  beforeEach(() => {
    readOmnigentFile.mockReset();
  });

  it("reads image attachments under your_files/uploads/ back and skips the rest", async () => {
    readOmnigentFile.mockResolvedValue({ path: "x", size: 4, truncated: false, bytes: png });
    const text = [
      ref("your_files/uploads/d/a.png", "image/png"),
      ref("your_files/uploads/d/doc.pdf", "application/pdf"),
      ref("elsewhere/b.png", "image/png"),
      ref("your_files/uploads/d/huge.png", "image/png", 6 * 1024 * 1024),
      "",
      "what is this?",
    ].join("\n");
    const images = await readTurnImages(CLIENT, "p@example.test", "sess-1", text);
    expect(images).toEqual([{ mimeType: "image/png", dataBase64: "iVBORw==" }]);
    expect(readOmnigentFile).toHaveBeenCalledTimes(1);
    expect(readOmnigentFile).toHaveBeenCalledWith(
      CLIENT,
      "p@example.test",
      "sess-1",
      "your_files/uploads/d/a.png",
    );
  });

  it("falls back to the path line when the read fails", async () => {
    readOmnigentFile.mockRejectedValue(new Error("read file failed (503)"));
    const images = await readTurnImages(
      CLIENT,
      "p@example.test",
      "sess-1",
      ref("your_files/uploads/d/a.png", "image/png"),
    );
    expect(images).toEqual([]);
  });

  it("posts the images with the turn", async () => {
    readOmnigentFile.mockResolvedValue({ path: "x", size: 4, truncated: false, bytes: png });
    getOmnigentMuse.mockResolvedValue({ session_id: "sess-1", agent: "agent", created: false });
    streamOmnigentSession.mockReturnValue(
      eventsFrom([{ type: "response.completed", response: { output: [] } }]),
    );
    const prompt = `${ref("your_files/uploads/d/a.png", "image/png")}\n\nlook`;
    const prisma = fakePrisma({
      task: { findUniqueOrThrow: vi.fn(async () => ({ prompt })) },
    });
    await runTurnOnOmnigent({ prisma, events: fakeEvents(), ...DEPS_BASE }, "run-1", "worker-1");
    expect(postOmnigentMessage).toHaveBeenLastCalledWith(
      CLIENT,
      "person@example.test",
      "sess-1",
      prompt,
      [{ mimeType: "image/png", dataBase64: "iVBORw==" }],
    );
  });
});

describe("attached documents", () => {
  const ref = (path: string, mime: string) =>
    `Attached file in your workspace: ${path} (${mime}, 10 bytes)`;

  beforeEach(() => {
    ingestOmnigentKnowledge.mockReset();
    postOmnigentMessage.mockReset();
  });

  const read = (over: Record<string, unknown>) => ({
    file_id: "ab12",
    name: "report.pdf",
    path: "your_files/uploads/d/report.pdf",
    pages: 2,
    ...over,
  });

  it("reads each document once, asking for the text inline", async () => {
    ingestOmnigentKnowledge.mockResolvedValue(read({ markdown: "<!-- page 1 -->\n\nHi" }));
    const text = [
      ref("your_files/uploads/d/report.pdf", "application/pdf"),
      ref("your_files/uploads/d/report.pdf", "application/pdf"),
      ref("your_files/uploads/d/a.png", "image/png"),
      ref("your_files/uploads/d/page.html", "text/html"),
    ].join("\n");
    const items = await readTurnAttachmentContext(CLIENT, "p@example.test", "sess-1", text);
    expect(items).toEqual([
      { name: "report.pdf", fileId: "ab12", pages: 2, markdown: "<!-- page 1 -->\n\nHi" },
    ]);
    expect(ingestOmnigentKnowledge).toHaveBeenCalledTimes(1);
    expect(ingestOmnigentKnowledge).toHaveBeenCalledWith(CLIENT, "p@example.test", "sess-1", {
      path: "your_files/uploads/d/report.pdf",
      inline: true,
    });
  });

  it("sends the text of a short file, or a manifest line for a long one, with the turn", async () => {
    getOmnigentMuse.mockResolvedValue({ session_id: "sess-1", agent: "agent", created: false });
    streamOmnigentSession.mockReturnValue(
      eventsFrom([{ type: "response.completed", response: { output: [] } }]),
    );
    for (const [extra, expected] of [
      [{ markdown: "SHORT TEXT" }, "SHORT TEXT"],
      [{ pages: 40 }, "indexed: report.pdf, 40 pages, file_id ab12; use files_query / files_get"],
    ] as const) {
      ingestOmnigentKnowledge.mockResolvedValue(read(extra));
      const prompt = `${ref("your_files/uploads/d/report.pdf", "application/pdf")}\n\nsummarise`;
      const prisma = fakePrisma({
        task: { findUniqueOrThrow: vi.fn(async () => ({ prompt })) },
      });
      await runTurnOnOmnigent({ prisma, events: fakeEvents(), ...DEPS_BASE }, "run-1", "worker-1");
      const sent = postOmnigentMessage.mock.calls.at(-1)?.[3] as string;
      expect(sent).toContain(expected);
      expect(sent.startsWith(prompt.split("\n\n")[0] as string)).toBe(true);
      expect(sent.endsWith("summarise")).toBe(true);
    }
  });

  it("leaves the path line alone when the Computer cannot read the file", async () => {
    ingestOmnigentKnowledge.mockRejectedValue(new Error("read file failed (503)"));
    const text = ref("your_files/uploads/d/report.pdf", "application/pdf");
    expect(await readTurnAttachmentContext(CLIENT, "p@example.test", "sess-1", text)).toEqual([]);
  });
});
