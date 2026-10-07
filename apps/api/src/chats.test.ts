import type { Actor } from "@aiden/contracts";
import type { PrismaClient } from "@aiden/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createOmnigentSideChat,
  getOmnigentContextSummary,
  getOmnigentWorkingProject,
  getOmnigentTranscript,
  postOmnigentMessage,
  omnigentClientConfigFromEnv,
  resolveChatOwnership,
  streamOmnigentFamily,
} = vi.hoisted(() => ({
  createOmnigentSideChat: vi.fn(),
  getOmnigentContextSummary: vi.fn(),
  getOmnigentWorkingProject: vi.fn(),
  getOmnigentTranscript: vi.fn(),
  postOmnigentMessage: vi.fn(),
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
    omnigentClientConfigFromEnv,
    resolveChatOwnership,
    streamOmnigentFamily,
  };
});

const { OmnigentSideChatError } = await import("@aiden/adapters");
const { createSideChat, getChatProject, getChatTranscript, summaryPreview, watchFamily } =
  await import("./chats.js");

const actor: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "person@example.test",
  isDeploymentOwner: true,
};

const CLIENT = { baseUrl: "http://omnigent.test", proxySecret: "secret", secrets: ["sk-secret"] };
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

  it("retries the first message once when the engine reports first_message_error, and still succeeds", async () => {
    createOmnigentSideChat.mockResolvedValue({
      conversation_id: "conv_new",
      title: "lunch ideas",
      start: "blank",
      first_message_error: "timed out",
    });
    postOmnigentMessage.mockResolvedValue(undefined);
    const deps = depsFor();

    const result = await createSideChat(
      deps,
      actor,
      { botId: "bot-1", start: "blank", text: "lunch ideas" },
      ENV,
    );

    expect(postOmnigentMessage).toHaveBeenCalledWith(
      CLIENT,
      "person@example.test",
      "conv_new",
      "lunch ideas",
    );
    expect(result.id).toBe("conv_new");
  });

  it("still returns the ChatSummary when the retried first message also fails", async () => {
    createOmnigentSideChat.mockResolvedValue({
      conversation_id: "conv_new",
      title: "lunch ideas",
      start: "blank",
      first_message_error: "timed out",
    });
    postOmnigentMessage.mockRejectedValue(new Error("still down"));
    const deps = depsFor();

    const result = await createSideChat(
      deps,
      actor,
      { botId: "bot-1", start: "blank", text: "lunch ideas" },
      ENV,
    );

    expect(result.id).toBe("conv_new");
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
    });
  });

  it("maps the engine's page as it comes, and redacts message text", async () => {
    getOmnigentTranscript.mockResolvedValue(
      transcriptPage(
        [
          { id: "msg_1", role: "user", created_at: 1000, blocks: [{ type: "text", text: "hi" }] },
          {
            id: "msg_2",
            role: "assistant",
            created_at: 2000,
            blocks: [{ type: "text", text: "the key is sk-secret" }],
          },
        ],
        { has_more: true, older_cursor: "msg_1" },
      ),
    );

    const page = await getChatTranscript(
      depsFor(),
      actor,
      { botId: "bot-1", chatId: "conv_side" },
      ENV,
    );

    expect(getOmnigentTranscript).toHaveBeenCalledWith(
      CLIENT,
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

  it("reports a reply still being written so the client keeps following it", async () => {
    resolveChatOwnership.mockResolvedValue({
      kind: "side_chat",
      superSessionId: "conv_super",
      botId: "bot-1",
      live: true,
    });
    getOmnigentTranscript.mockResolvedValue(transcriptPage([]));

    const page = await getChatTranscript(
      depsFor(),
      actor,
      { botId: "bot-1", chatId: "conv_side" },
      ENV,
    );

    expect(page.running).toBe(true);
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
      CLIENT,
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
      { type: "chatsChanged" },
      { type: "activitiesChanged" },
      { type: "heartbeat" },
    ]);
    expect(streamOmnigentFamily.mock.calls[0]?.slice(0, 3)).toEqual([
      CLIENT,
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
      CLIENT,
      "person@example.test",
      "conv_super",
    );
    expect(resolveChatOwnership).not.toHaveBeenCalled();
  });

  it("reads a Side Chat's Project once the Muse owns that chat", async () => {
    resolveChatOwnership.mockResolvedValue({ botId: "bot-1", live: false });
    getOmnigentWorkingProject.mockResolvedValue(null);

    const result = await getChatProject(
      depsFor(),
      actor,
      { botId: "bot-1", chatId: "conv_side" },
      ENV,
    );

    expect(result).toEqual({ project: null });
    expect(getOmnigentWorkingProject).toHaveBeenCalledWith(
      CLIENT,
      "person@example.test",
      "conv_side",
    );
  });

  it("refuses a chat the person does not own", async () => {
    resolveChatOwnership.mockResolvedValue(null);

    await expect(
      getChatProject(depsFor(), actor, { botId: "bot-1", chatId: "conv_other" }, ENV),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(getOmnigentWorkingProject).not.toHaveBeenCalled();
  });
});
