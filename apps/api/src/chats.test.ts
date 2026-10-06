import type { Actor } from "@aiden/contracts";
import type { PrismaClient } from "@aiden/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createOmnigentSideChat,
  getOmnigentContextSummary,
  getOmnigentWorkingProject,
  listOmnigentSessionItems,
  postOmnigentMessage,
  omnigentClientConfigFromEnv,
  resolveChatOwnership,
} = vi.hoisted(() => ({
  createOmnigentSideChat: vi.fn(),
  getOmnigentContextSummary: vi.fn(),
  getOmnigentWorkingProject: vi.fn(),
  listOmnigentSessionItems: vi.fn(),
  postOmnigentMessage: vi.fn(),
  omnigentClientConfigFromEnv: vi.fn(),
  // The ownership rule itself is covered against a mocked Omnigent client in
  // packages/adapters/src/omnigent/chats.test.ts — here it's faked so `getChatMessages`
  // never makes a real network call just to resolve which Super Chat owns `chatId`.
  resolveChatOwnership: vi.fn(),
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
    listOmnigentSessionItems,
    postOmnigentMessage,
    omnigentClientConfigFromEnv,
    resolveChatOwnership,
  };
});

const { OmnigentSideChatError } = await import("@aiden/adapters");
const { createSideChat, getChatMessages, getChatProject, summaryPreview } = await import(
  "./chats.js"
);

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

describe("getChatMessages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    omnigentClientConfigFromEnv.mockReturnValue(CLIENT);
    resolveChatOwnership.mockResolvedValue({
      kind: "side_chat",
      superSessionId: "conv_super",
      botId: "bot-1",
    });
  });

  it("fetches newest-first, reverses for display, and redacts message text", async () => {
    listOmnigentSessionItems.mockResolvedValue({
      data: [
        {
          id: "msg_2",
          type: "message",
          role: "assistant",
          created_at: 2000,
          content: [{ type: "output_text", text: "the key is sk-secret" }],
        },
        {
          id: "msg_1",
          type: "message",
          role: "user",
          created_at: 1000,
          content: [{ type: "input_text", text: "hi" }],
        },
      ],
      has_more: true,
    });
    const deps = depsFor();

    const page = await getChatMessages(deps, actor, { chatId: "conv_side" }, ENV);

    expect(listOmnigentSessionItems).toHaveBeenCalledWith(
      CLIENT,
      "person@example.test",
      "conv_side",
      expect.objectContaining({ order: "desc", before: undefined }),
    );
    // Reversed: oldest (msg_1) first, newest (msg_2) last.
    expect(page.messages.map((m) => m.id)).toEqual(["msg_1", "msg_2"]);
    expect(page.messages[1]?.blocks).toEqual([{ kind: "text", text: "the key is [redacted]" }]);
    // has_more: true -> the oldest item in the fetched (desc) page is the next "before" cursor.
    expect(page.olderItemCursor).toBe("msg_1");
    expect(page.running).toBe(false);
  });

  it("reports a reply still being written so the client keeps following it", async () => {
    resolveChatOwnership.mockResolvedValue({
      kind: "side_chat",
      superSessionId: "conv_super",
      botId: "bot-1",
      live: true,
    });
    listOmnigentSessionItems.mockResolvedValue({ data: [], has_more: false });

    const page = await getChatMessages(depsFor(), actor, { chatId: "conv_side" }, ENV);

    expect(page.running).toBe(true);
  });

  it("shows only a with-context side chat's own messages, after its seed", async () => {
    resolveChatOwnership.mockResolvedValue({
      kind: "side_chat",
      superSessionId: "conv_super",
      botId: "bot-1",
      seedItemId: "seed_1",
    });
    listOmnigentSessionItems.mockResolvedValue({
      data: [
        {
          id: "msg_own",
          type: "message",
          role: "user",
          created_at: 3000,
          content: [{ type: "input_text", text: "side question" }],
        },
        { id: "seed_1", type: "compaction", created_at: 2000 },
        {
          id: "msg_copied",
          type: "message",
          role: "user",
          created_at: 1000,
          content: [{ type: "input_text", text: "copied from the Conversation" }],
        },
      ],
      has_more: true,
    });

    const page = await getChatMessages(depsFor(), actor, { chatId: "conv_side" }, ENV);

    expect(page.messages.map((m) => m.id)).toEqual(["msg_own"]);
    expect(page.olderItemCursor).toBeNull();
  });

  it("forwards the before cursor and reports no older page when has_more is false", async () => {
    listOmnigentSessionItems.mockResolvedValue({ data: [], has_more: false });
    const deps = depsFor();

    const page = await getChatMessages(deps, actor, { chatId: "conv_side", before: "msg_1" }, ENV);

    expect(listOmnigentSessionItems).toHaveBeenCalledWith(
      CLIENT,
      "person@example.test",
      "conv_side",
      expect.objectContaining({ before: "msg_1" }),
    );
    expect(page.olderItemCursor).toBeNull();
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
