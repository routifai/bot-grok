import type { PrismaClient, ThreadEvents } from "@nova/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OmnigentApiError } from "./client.js";
import {
  COMPUTER_START_FAILED_MESSAGE,
  ENGINE_FAILED_MESSAGE,
  ENGINE_INTERRUPTED_MESSAGE,
  failRunUnsupportedOnOmnigent,
  publicRunError,
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

  it("posts the message exactly as the person wrote it: no file text, no ingest hop", async () => {
    getOmnigentMuse.mockResolvedValue({ session_id: "sess-1", agent: "agent", created: false });
    streamOmnigentSession.mockReturnValue(
      eventsFrom([{ type: "response.completed", response: { output: [] } }]),
    );
    const xlsx = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    const prompt = `${ref("your_files/uploads/d/report.pdf", "application/pdf")}\n${ref("your_files/uploads/d/b.xlsx", xlsx)}\n\nsummarise`;
    const prisma = fakePrisma({ task: { findUniqueOrThrow: vi.fn(async () => ({ prompt })) } });
    await runTurnOnOmnigent({ prisma, events: fakeEvents(), ...DEPS_BASE }, "run-1", "worker-1");
    expect(postOmnigentMessage.mock.calls.at(-1)?.[3]).toBe(prompt);
    expect(ingestOmnigentKnowledge).not.toHaveBeenCalled();
  });
});
