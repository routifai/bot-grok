import type { Actor } from "@aiden/contracts";
import type { PrismaClient } from "@aiden/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createOmnigentSideChat,
  getOmnigentContextSummary,
  getOmnigentWorkingProject,
  getOmnigentTranscript,
  postOmnigentMessage,
  markOmnigentRead,
  resetOmnigentSession,
  omnigentClientConfigFromEnv,
  resolveChatOwnership,
  streamOmnigentFamily,
} = vi.hoisted(() => ({
  createOmnigentSideChat: vi.fn(),
  getOmnigentContextSummary: vi.fn(),
  getOmnigentWorkingProject: vi.fn(),
  getOmnigentTranscript: vi.fn(),
  postOmnigentMessage: vi.fn(),
  markOmnigentRead: vi.fn(),
  resetOmnigentSession: vi.fn(),
  omnigentClientConfigFromEnv: vi.fn(),
  // The ownership rule itself is covered against a mocked Omnigent client in
  // packages/adapters/src/omnigent/chats.test.ts — here it's faked so `getChatTranscript`
  // never makes a real network call just to resolve which Super Chat owns `chatId`.
  resolveChatOwnership: vi.fn(),
  streamOmnigentFamily: vi.fn(),
}));

// Real mapping/error classes (OmnigentSideChatError, mapSideChatCreateToSummary, ...) stay
// real so `instanceof` checks and the actual mapping shape are exercised; only the
// network-touching client calls and the env-gating function are faked.
vi.mock("@aiden/adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aiden/adapters")>();
  return {
    ...actual,
    createOmnigentSideChat,
    getOmnigentContextSummary,
    getOmnigentWorkingProject,
    getOmnigentTranscript,
    postOmnigentMessage,
    markOmnigentRead,
    resetOmnigentSession,
    omnigentClientConfigFromEnv,
    resolveChatOwnership,
    streamOmnigentFamily,
  };
});

const { OmnigentSideChatError } = await import("@aiden/adapters");
const { OmnigentApiError } = await import("@aiden/adapters");
const {
  createSideChat,
  getChatProject,
  getChatTranscript,
  markChatRead,
  resetConversation,
  sendToChat,
  summaryPreview,
  watchFamily,
} = await import("./chats.js");

const actor: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "person@example.test",
  isDeploymentOwner: true,
};

const CLIENT = { baseUrl: "http://omnigent.test", proxySecret: "secret", secrets: ["sk-secret"] };
/** The connection bound to the actor's space, as every engine call sends it. */
const BOUND = { ...CLIENT, tenant: "space-1" };
const ENV = { OMNIGENT_URL: "http://omnigent.test", OMNIGENT_PROXY_SECRET: "secret" };

function depsFor(overrides: Record<string, unknown> = {}) {
  const base = {
    bot: { findFirst: vi.fn(async () => ({ id: "bot-1" })) },
    user: { findUnique: vi.fn(async () => ({ email: "person@example.test" })) },
    omnigentSession: {
      findUnique: vi.fn(async () => ({ omnigentSessionId: "conv_super" })),
      findMany: vi.fn(async () => [{ botId: "bot-1", omnigentSessionId: "conv_super" }]),
    },
  };
  return { prisma: { ...base, ...overrides } as unknown as PrismaClient };
}

describe("createSideChat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    omnigentClientConfigFromEnv.mockReturnValue(CLIENT);
  });

  it("returns the ChatSummary when the engine creates the chat and its first message cleanly", async () => {
    createOmnigentSideChat.mockResolvedValue({
      conversation_id: "conv_new",
      title: "lunch ideas",
      start: "blank",
    });
    const deps = depsFor();

    const result = await createSideChat(
      deps,
      actor,
      { botId: "bot-1", start: "blank", text: "lunch ideas" },
      ENV,
    );

    expect(result.id).toBe("conv_new");
    expect(postOmnigentMessage).not.toHaveBeenCalled();
  });

  it("does not retry the first message itself; the engine's failure code reaches the summary", async () => {
    createOmnigentSideChat.mockResolvedValue({
      conversation_id: "conv_new",
      title: "lunch ideas",
      start: "blank",
      first_message_error: "runner is starting",
      first_message_error_code: "runner_unavailable",
    });
    const deps = depsFor();

    const result = await createSideChat(
      deps,
      actor,
      { botId: "bot-1", start: "blank", text: "lunch ideas" },
      ENV,
    );

    expect(postOmnigentMessage).not.toHaveBeenCalled();
    expect(result.id).toBe("conv_new");
    expect(result.firstMessageErrorCode).toBe("runner_unavailable");
  });

  it('surfaces the specific "didn\'t send" message when the error body shows the chat was created', async () => {
    createOmnigentSideChat.mockRejectedValue(
      new OmnigentSideChatError("omnigent create side chat failed (502): ", "conv_new"),
    );
    const deps = depsFor();

    await expect(
      createSideChat(deps, actor, { botId: "bot-1", start: "blank", text: "hi" }, ENV),
    ).rejects.toThrow(/didn't send/);
  });

  it("surfaces a generic failure when nothing indicates the chat was created", async () => {
    createOmnigentSideChat.mockRejectedValue(
      new OmnigentSideChatError("omnigent create side chat failed (500): ", null),
    );
    const deps = depsFor();

    await expect(
      createSideChat(deps, actor, { botId: "bot-1", start: "blank", text: "hi" }, ENV),
    ).rejects.toThrow(/Could not open a side chat/);
  });
});

describe("summaryPreview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    omnigentClientConfigFromEnv.mockReturnValue(CLIENT);
  });

  it("shows the engine's person-facing body, not the model-facing summary", async () => {
    getOmnigentContextSummary.mockResolvedValue({
      summary: "[framing] Goal: plan Q4",
      summary_body: "Goal: plan Q4",
      created_at: 1,
    });
    await expect(summaryPreview(depsFor(), actor, { botId: "bot-1" }, ENV)).resolves.toEqual({
      summary: "Goal: plan Q4",
    });
  });

  it("is empty before the Conversation has rolled over", async () => {
    getOmnigentContextSummary.mockResolvedValue({
      summary: null,
      summary_body: null,
      created_at: null,
    });
    await expect(summaryPreview(depsFor(), actor, { botId: "bot-1" }, ENV)).resolves.toEqual({
      summary: "",
    });
  });
});

const transcriptPage = (
  data: unknown[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  data,
  has_more: false,
  older_cursor: null,
  lineage: { kind: "side", root_id: "conv_super", parent_id: "conv_super", seed_item_id: null },
  ...extra,
});

describe("getChatTranscript", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    omnigentClientConfigFromEnv.mockReturnValue(CLIENT);
    resolveChatOwnership.mockResolvedValue({
      kind: "side_chat",
      superSessionId: "conv_super",
      botId: "bot-1",
      project: null,
    });
  });

  it("maps the engine's page as it comes (the engine has redacted it)", async () => {
    getOmnigentTranscript.mockResolvedValue(
      transcriptPage(
        [
          { id: "msg_1", role: "user", created_at: 1000, blocks: [{ type: "text", text: "hi" }] },
          {
            id: "msg_2",
            role: "assistant",
            created_at: 2000,
            blocks: [{ type: "text", text: "the key is [redacted]" }],
          },
        ],
        { has_more: true, older_cursor: "msg_1", live: false },
      ),
    );

    const page = await getChatTranscript(
      depsFor(),
      actor,
      { botId: "bot-1", chatId: "conv_side" },
      ENV,
    );

    expect(getOmnigentTranscript).toHaveBeenCalledWith(
      BOUND,
      "person@example.test",
      "conv_side",
      expect.objectContaining({ before: undefined }),
    );
    expect(page.messages.map((m) => m.id)).toEqual(["msg_1", "msg_2"]);
    expect(page.messages[1]?.blocks).toEqual([{ kind: "text", text: "the key is [redacted]" }]);
    expect(page.olderItemCursor).toBe("msg_1");
    expect(page.running).toBe(false);
  });

  it("reads the Conversation itself when no chat is named", async () => {
    getOmnigentTranscript.mockResolvedValue(transcriptPage([]));

    const page = await getChatTranscript(depsFor(), actor, { botId: "bot-1" }, ENV);

    expect(getOmnigentTranscript.mock.calls[0]?.[2]).toBe("conv_super");
    expect(resolveChatOwnership).not.toHaveBeenCalled();
    expect(page.threadId).toBe("conv_super");
    expect(page.running).toBeUndefined();
  });

  it("reports a reply still being written from the transcript's own live flag", async () => {
    getOmnigentTranscript.mockResolvedValue(transcriptPage([], { live: true }));

    const page = await getChatTranscript(
      depsFor(),
      actor,
      { botId: "bot-1", chatId: "conv_side" },
      ENV,
    );

    expect(page.running).toBe(true);
  });

  it("reports the reset and forwards beforeReset", async () => {
    getOmnigentTranscript.mockResolvedValue(
      transcriptPage([], { reset: { item_id: "r1", created_at: 5 } }),
    );

    const page = await getChatTranscript(
      depsFor(),
      actor,
      { botId: "bot-1", beforeReset: true },
      ENV,
    );

    expect(getOmnigentTranscript).toHaveBeenCalledWith(
      BOUND,
      "person@example.test",
      "conv_super",
      expect.objectContaining({ beforeReset: true }),
    );
    expect(page.reset?.itemId).toBe("r1");
  });

  it("forwards the before cursor", async () => {
    getOmnigentTranscript.mockResolvedValue(transcriptPage([]));

    const page = await getChatTranscript(
      depsFor(),
      actor,
      { botId: "bot-1", chatId: "conv_side", before: "msg_1" },
      ENV,
    );

    expect(getOmnigentTranscript).toHaveBeenCalledWith(
      BOUND,
      "person@example.test",
      "conv_side",
      expect.objectContaining({ before: "msg_1" }),
    );
    expect(page.olderItemCursor).toBeNull();
  });

  it("refuses a chat that belongs to another Muse", async () => {
    resolveChatOwnership.mockResolvedValue({
      kind: "side_chat",
      superSessionId: "conv_other",
      botId: "bot-2",
    });

    await expect(
      getChatTranscript(depsFor(), actor, { botId: "bot-1", chatId: "conv_side" }, ENV),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(getOmnigentTranscript).not.toHaveBeenCalled();
  });
});

describe("watchFamily", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    omnigentClientConfigFromEnv.mockReturnValue(CLIENT);
  });

  it("relays the engine's family events as ids only", async () => {
    streamOmnigentFamily.mockImplementation(async function* () {
      yield { type: "message.done", chat_id: "conv_side", item_id: "msg_9" };
      yield { type: "chat.reset", chat_id: "conv_super", item_id: "r1" };
      yield { type: "chats.changed", root_id: "conv_super" };
      yield { type: "activities.changed", root_id: "conv_super" };
      yield { type: "session.heartbeat" };
    });

    const events = [];
    for await (const event of watchFamily(depsFor(), actor, { botId: "bot-1" }, undefined, ENV)) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "open" },
      { type: "messageDone", chatId: "conv_side", itemId: "msg_9" },
      { type: "chatReset", chatId: "conv_super", itemId: "r1" },
      { type: "chatsChanged" },
      { type: "activitiesChanged" },
      { type: "heartbeat" },
    ]);
    expect(streamOmnigentFamily.mock.calls[0]?.slice(0, 3)).toEqual([
      BOUND,
      "person@example.test",
      "conv_super",
    ]);
  });

  it("treats a closed tab as the normal end of the watch", async () => {
    const abort = new AbortController();
    streamOmnigentFamily.mockImplementation(() => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          abort.abort();
          throw new DOMException("aborted", "AbortError");
        },
      }),
    }));

    const events = [];
    for await (const event of watchFamily(
      depsFor(),
      actor,
      { botId: "bot-1" },
      abort.signal,
      ENV,
    )) {
      events.push(event);
    }

    expect(events).toEqual([{ type: "open" }]);
  });
});

describe("markChatRead and resetConversation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    omnigentClientConfigFromEnv.mockReturnValue(CLIENT);
  });

  it("marks a side chat read once the Muse owns it", async () => {
    resolveChatOwnership.mockResolvedValue({ kind: "side_chat", botId: "bot-1" });
    await markChatRead(depsFor(), actor, { botId: "bot-1", chatId: "conv_side" }, ENV);
    expect(markOmnigentRead).toHaveBeenCalledWith(BOUND, "person@example.test", "conv_side");
  });

  it("clears the Conversation on the engine", async () => {
    await resetConversation(depsFor(), actor, { botId: "bot-1" }, ENV);
    expect(resetOmnigentSession).toHaveBeenCalledWith(BOUND, "person@example.test", "conv_super");
  });

  it("answers CONFLICT while a turn is running", async () => {
    resetOmnigentSession.mockRejectedValue(
      new OmnigentApiError("omnigent reset failed (409)", "conflict"),
    );
    await expect(
      resetConversation(depsFor(), actor, { botId: "bot-1" }, ENV),
    ).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});

describe("getChatProject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    omnigentClientConfigFromEnv.mockReturnValue(CLIENT);
  });

  it("reads the Conversation's own Project when no chat is named", async () => {
    getOmnigentWorkingProject.mockResolvedValue({ slug: "q3-deck", name: "Q3 board deck" });

    const result = await getChatProject(depsFor(), actor, { botId: "bot-1" }, ENV);

    expect(result).toEqual({ project: { slug: "q3-deck", name: "Q3 board deck" } });
    expect(getOmnigentWorkingProject).toHaveBeenCalledWith(
      BOUND,
      "person@example.test",
      "conv_super",
    );
    expect(resolveChatOwnership).not.toHaveBeenCalled();
  });

  it("reads a Side Chat's Project from its session once the Muse owns that chat", async () => {
    const project = { slug: "q3-deck", name: "Q3 board deck" };
    resolveChatOwnership.mockResolvedValue({ botId: "bot-1", live: false, project });

    const result = await getChatProject(
      depsFor(),
      actor,
      { botId: "bot-1", chatId: "conv_side" },
      ENV,
    );

    expect(result).toEqual({ project });
    expect(getOmnigentWorkingProject).not.toHaveBeenCalled();
  });

  it("refuses a chat the person does not own", async () => {
    resolveChatOwnership.mockResolvedValue(null);

    await expect(
      getChatProject(depsFor(), actor, { botId: "bot-1", chatId: "conv_other" }, ENV),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(getOmnigentWorkingProject).not.toHaveBeenCalled();
  });
});

describe("Helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    omnigentClientConfigFromEnv.mockReturnValue(CLIENT);
    resolveChatOwnership.mockResolvedValue({
      kind: "helper",
      superSessionId: "conv_super",
      botId: "bot-1",
      live: false,
      project: null,
    });
  });

  it("marks a Helper's transcript read-only so the client shows no composer", async () => {
    getOmnigentTranscript.mockResolvedValue({ data: [], has_more: false, older_cursor: null });

    const page = await getChatTranscript(
      depsFor(),
      actor,
      { botId: "bot-1", chatId: "conv_helper" },
      ENV,
    );

    expect(page.readOnly).toBe(true);
  });

  it("leaves refusing a post to the engine, and says why in short copy", async () => {
    postOmnigentMessage.mockRejectedValue(
      new OmnigentApiError("omnigent post message event failed (403)", "helper_read_only"),
    );

    await expect(
      sendToChat(depsFor(), actor, { chatId: "conv_helper", text: "hi" }, ENV),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "Helpers are read-only." });
    expect(postOmnigentMessage).toHaveBeenCalledWith(
      BOUND,
      "person@example.test",
      "conv_helper",
      "hi",
    );
  });
});
