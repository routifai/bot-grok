import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const adapters = vi.hoisted(() => ({
  createOmnigentSideChat: vi.fn(),
  getOmnigentContextSummary: vi.fn(),
  getOmnigentTranscript: vi.fn(),
  postOmnigentMessage: vi.fn(),
  readTurnImages: vi.fn(),
  resolveChatOwnership: vi.fn(),
  streamOmnigentFamily: vi.fn(),
  resetOmnigentSession: vi.fn(),
  getOmnigentArchiving: vi.fn(),
  putOmnigentArchiving: vi.fn(),
  addOmnigentForkToConversation: vi.fn(),
  archiveOmnigentSession: vi.fn(),
  getOmnigentWorkspaceRoot: vi.fn(),
  moveOmnigentSessionForPerson: vi.fn(),
}));

// The mapping and error classes stay real so `instanceof` checks and the mapped shapes are
// exercised; only the calls that reach the engine are faked.
vi.mock("@superchat/adapters/omnigent/browser", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@superchat/adapters/omnigent/browser")>()),
  ...adapters,
}));
vi.mock("./client", () => ({
  engineClient: () => ({ baseUrl: "http://engine.test", proxySecret: "", secrets: [] }),
  museSessionId: async () => "conv_super",
  NO_EMAIL: "",
}));

const { OmnigentApiError, OmnigentSideChatError } = await import(
  "@superchat/adapters/omnigent/browser"
);
const { chatsRouter } = await import("./chats");

const OWNED = {
  kind: "side_chat",
  superSessionId: "conv_super",
  botId: "conv_super",
  project: null,
  folder: null,
  chosen: false,
};
const run = <T>(procedure: unknown, input: unknown) =>
  call(procedure as never, input as never) as Promise<T>;

beforeEach(() => vi.resetAllMocks());

describe("chats.createSide", () => {
  it("maps the created chat and sends its first message through the engine", async () => {
    adapters.createOmnigentSideChat.mockResolvedValue({
      conversation_id: "conv_new",
      title: "lunch ideas",
      start: "blank",
      first_message_error_code: "runner_unavailable",
    });
    const result = await run<{ id: string; firstMessageErrorCode?: string }>(
      chatsRouter.chats.createSide,
      { botId: "conv_super", start: "blank", text: "lunch ideas" },
    );
    expect(result.id).toBe("conv_new");
    expect(result.firstMessageErrorCode).toBe("runner_unavailable");
    expect(adapters.postOmnigentMessage).not.toHaveBeenCalled();
    expect(adapters.createOmnigentSideChat).toHaveBeenCalledWith(
      expect.anything(),
      "",
      "conv_super",
      { start: "blank", firstMessage: "lunch ideas" },
    );
  });

  it("says the first message didn't send when the chat exists, and fails plainly otherwise", async () => {
    const input = { botId: "conv_super", start: "blank", text: "hi" };
    adapters.createOmnigentSideChat.mockRejectedValueOnce(
      new OmnigentSideChatError("failed (502)", "conv_new"),
    );
    await expect(run(chatsRouter.chats.createSide, input)).rejects.toThrow(/didn't send/);
    adapters.createOmnigentSideChat.mockRejectedValueOnce(
      new OmnigentSideChatError("failed (500)", null),
    );
    await expect(run(chatsRouter.chats.createSide, input)).rejects.toThrow(
      /Could not open a side chat/,
    );
  });

  it("refuses a Muse that is not the person's", async () => {
    await expect(
      run(chatsRouter.chats.createSide, { botId: "other", start: "blank", text: "hi" }),
    ).rejects.toThrow(/Muse not found/);
    expect(adapters.createOmnigentSideChat).not.toHaveBeenCalled();
  });
});

describe("chats.createSide in a folder and chats.setFolder", () => {
  const ROOT = "/home/u/workspace";

  it("moves the new chat into the chosen folder before its first message", async () => {
    adapters.getOmnigentWorkspaceRoot.mockResolvedValue(ROOT);
    adapters.createOmnigentSideChat.mockResolvedValue({
      conversation_id: "conv_new",
      title: "q3",
      start: "withContext",
    });
    await run(chatsRouter.chats.createSide, {
      botId: "conv_super",
      start: "withContext",
      text: "look",
      folder: "projects/q3",
    });
    expect(adapters.moveOmnigentSessionForPerson).toHaveBeenCalledWith(
      expect.anything(),
      "",
      "conv_new",
      `${ROOT}/projects/q3`,
      true,
    );
    expect(adapters.postOmnigentMessage).toHaveBeenCalledWith(
      expect.anything(),
      "",
      "conv_new",
      "look",
    );
  });

  it("moves a side chat for the person, and back to the whole workspace without the mark", async () => {
    adapters.getOmnigentWorkspaceRoot.mockResolvedValue(ROOT);
    adapters.resolveChatOwnership.mockResolvedValue(OWNED);
    await run(chatsRouter.chats.setFolder, {
      botId: "conv_super",
      chatId: "conv_side",
      folder: "reports",
    });
    expect(adapters.moveOmnigentSessionForPerson).toHaveBeenLastCalledWith(
      expect.anything(),
      "",
      "conv_side",
      `${ROOT}/reports`,
      true,
    );
    await run(chatsRouter.chats.setFolder, { botId: "conv_super", folder: null });
    expect(adapters.moveOmnigentSessionForPerson).toHaveBeenLastCalledWith(
      expect.anything(),
      "",
      "conv_super",
      ROOT,
      false,
    );
  });

  it("refuses a folder outside the workspace and a chat that is not the Muse's", async () => {
    adapters.getOmnigentWorkspaceRoot.mockResolvedValue(ROOT);
    await expect(
      run(chatsRouter.chats.setFolder, { botId: "conv_super", folder: "../etc" }),
    ).rejects.toThrow(/outside the workspace/);
    adapters.resolveChatOwnership.mockResolvedValue(null);
    await expect(
      run(chatsRouter.chats.setFolder, { botId: "conv_super", chatId: "x", folder: "a" }),
    ).rejects.toThrow(/not found/i);
    expect(adapters.moveOmnigentSessionForPerson).not.toHaveBeenCalled();
  });
});

describe("chats.createFork and addToConversation", () => {
  it("forks a Conversation message, or a fork's message once the Muse owns it", async () => {
    adapters.createOmnigentSideChat.mockResolvedValue({ conversation_id: "conv_fork", title: "t" });
    adapters.resolveChatOwnership.mockResolvedValue(OWNED);
    await run(chatsRouter.chats.createFork, {
      botId: "conv_super",
      anchorItemId: "item_1",
      text: "why",
    });
    expect(adapters.createOmnigentSideChat).toHaveBeenLastCalledWith(
      expect.anything(),
      "",
      "conv_super",
      { start: "with_context", firstMessage: "why", anchorItemId: "item_1" },
    );
    await run(chatsRouter.chats.createFork, {
      botId: "conv_super",
      chatId: "conv_a",
      anchorItemId: "item_2",
      text: "and",
    });
    expect(adapters.createOmnigentSideChat).toHaveBeenLastCalledWith(
      expect.anything(),
      "",
      "conv_a",
      expect.objectContaining({ anchorItemId: "item_2" }),
    );
  });

  it("refuses a chat the person does not own before asking the engine", async () => {
    adapters.resolveChatOwnership.mockResolvedValue(null);
    await expect(
      run(chatsRouter.chats.createFork, {
        botId: "conv_super",
        chatId: "conv_x",
        anchorItemId: "i",
        text: "t",
      }),
    ).rejects.toThrow(/Chat not found/);
    expect(adapters.createOmnigentSideChat).not.toHaveBeenCalled();
  });

  it("passes the engine's refusals through as their own codes", async () => {
    const input = { botId: "conv_super", anchorItemId: "i", text: "t" };
    adapters.createOmnigentSideChat.mockRejectedValueOnce(
      Object.assign(new OmnigentSideChatError("x", null), { code: "fork_too_deep" }),
    );
    await expect(run(chatsRouter.chats.createFork, input)).rejects.toMatchObject({
      code: "FORK_TOO_DEEP",
      status: 422,
    });
    adapters.createOmnigentSideChat.mockRejectedValueOnce(
      Object.assign(new OmnigentSideChatError("x", null), { code: "fork_anchor_invalid" }),
    );
    await expect(run(chatsRouter.chats.createFork, input)).rejects.toMatchObject({
      code: "FORK_ANCHOR_INVALID",
    });
  });

  it("adds a fork's summary back, only for the Muse's own Side Chats", async () => {
    adapters.addOmnigentForkToConversation.mockResolvedValue({ summary: "done" });
    adapters.resolveChatOwnership.mockResolvedValueOnce({ ...OWNED, kind: "helper" });
    await expect(
      run(chatsRouter.chats.addToConversation, { botId: "conv_super", chatId: "conv_h" }),
    ).rejects.toThrow(/Chat not found/);
    adapters.resolveChatOwnership.mockResolvedValueOnce(OWNED);
    await expect(
      run(chatsRouter.chats.addToConversation, { botId: "conv_super", chatId: "conv_a" }),
    ).resolves.toEqual({ summary: "done" });
  });
});

describe("chats.summaryPreview", () => {
  it("shows the engine's person-facing body, empty before the first rollover", async () => {
    adapters.getOmnigentContextSummary.mockResolvedValueOnce({ summary_body: "So far..." });
    await expect(run(chatsRouter.chats.summaryPreview, { botId: "conv_super" })).resolves.toEqual({
      summary: "So far...",
    });
    adapters.getOmnigentContextSummary.mockResolvedValueOnce({});
    await expect(run(chatsRouter.chats.summaryPreview, { botId: "conv_super" })).resolves.toEqual({
      summary: "",
    });
  });
});

describe("chats.transcript", () => {
  const page = { data: [], has_more: false, live: false };

  it("reads the Conversation when no chat is named and forwards the paging", async () => {
    adapters.getOmnigentTranscript.mockResolvedValue(page);
    await run(chatsRouter.chats.transcript, {
      botId: "conv_super",
      before: "cur_1",
      beforeReset: true,
    });
    expect(adapters.getOmnigentTranscript).toHaveBeenCalledWith(
      expect.anything(),
      "",
      "conv_super",
      {
        limit: 50,
        before: "cur_1",
        beforeReset: true,
      },
    );
  });

  it("marks a Helper's transcript read-only and refuses another Muse's chat", async () => {
    adapters.getOmnigentTranscript.mockResolvedValue(page);
    adapters.resolveChatOwnership.mockResolvedValueOnce({ ...OWNED, kind: "helper" });
    const result = await run<{ readOnly?: boolean }>(chatsRouter.chats.transcript, {
      botId: "conv_super",
      chatId: "conv_h",
    });
    expect(result.readOnly).toBe(true);
    adapters.resolveChatOwnership.mockResolvedValueOnce({ ...OWNED, botId: "other" });
    await expect(
      run(chatsRouter.chats.transcript, { botId: "conv_super", chatId: "conv_z" }),
    ).rejects.toThrow(/Chat not found/);
  });
});

describe("chats.watch", () => {
  async function collect(signal?: AbortSignal) {
    const events: unknown[] = [];
    const stream = await run<AsyncIterable<unknown>>(chatsRouter.chats.watch, {
      botId: "conv_super",
    });
    void signal;
    for await (const event of stream) events.push(event);
    return events;
  }

  it("relays the engine's family events as ids only", async () => {
    adapters.streamOmnigentFamily.mockImplementation(async function* () {
      yield { type: "message.done", chat_id: "c1", item_id: "i1" };
      yield { type: "message.delivery", chat_id: "c1", item_id: "i2" };
      yield { type: "chat.reset", chat_id: "c1", item_id: "i3" };
      yield { type: "turn.done", chat_id: "c1", status: "completed" };
      yield { type: "chats.changed" };
      yield { type: "activities.changed" };
      yield { type: "session.heartbeat" };
    });
    expect(await collect()).toEqual([
      { type: "open" },
      { type: "messageDone", chatId: "c1", itemId: "i1" },
      { type: "messageDelivery", chatId: "c1", itemId: "i2" },
      { type: "chatReset", chatId: "c1", itemId: "i3" },
      { type: "turnDone", chatId: "c1", status: "completed" },
      { type: "chatsChanged" },
      { type: "activitiesChanged" },
      { type: "heartbeat" },
    ]);
  });
});

describe("chats.reset", () => {
  it("answers CONFLICT while a turn is running", async () => {
    adapters.resetOmnigentSession.mockRejectedValue(new OmnigentApiError("busy", "conflict"));
    await expect(run(chatsRouter.chats.reset, { botId: "conv_super" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});

describe("chats.send", () => {
  beforeEach(() => adapters.readTurnImages.mockResolvedValue([]));

  it("sends to the Conversation when no chat is named", async () => {
    await run(chatsRouter.chats.send, { botId: "conv_super", text: "hello" });
    expect(adapters.postOmnigentMessage).toHaveBeenCalledWith(
      expect.anything(),
      "",
      "conv_super",
      "hello",
    );
  });

  it("writes a reference line per attached file and folder, then the caption", async () => {
    await run(chatsRouter.chats.send, {
      botId: "conv_super",
      text: "look",
      attachments: [
        { path: "your_files/uploads/a.pdf", name: "a.pdf", mimeType: "application/pdf", size: 12 },
      ],
      folders: ["reports"],
    });
    const text = adapters.postOmnigentMessage.mock.calls[0]?.[3] as string;
    expect(text).toContain(
      "Attached file in your workspace: your_files/uploads/a.pdf (application/pdf, 12 bytes)",
    );
    expect(text).toContain("Attached folder in your workspace: reports/");
    expect(text.endsWith("look")).toBe(true);
  });

  it("hands attached images to the model as images", async () => {
    adapters.readTurnImages.mockResolvedValue([{ mime: "image/png", data: "AA==" }]);
    await run(chatsRouter.chats.send, { botId: "conv_super", text: "see" });
    expect(adapters.postOmnigentMessage).toHaveBeenCalledWith(
      expect.anything(),
      "",
      "conv_super",
      "see",
      [{ mime: "image/png", data: "AA==" }],
    );
  });

  it("refuses a file outside the uploads folder and a chat that is not the Muse's", async () => {
    await expect(
      run(chatsRouter.chats.send, {
        botId: "conv_super",
        attachments: [
          { path: "secrets/a.pdf", name: "a.pdf", mimeType: "application/pdf", size: 1 },
        ],
      }),
    ).rejects.toThrow(/not an uploaded file/);
    adapters.resolveChatOwnership.mockResolvedValue(null);
    await expect(run(chatsRouter.chats.send, { chatId: "conv_x", text: "hi" })).rejects.toThrow(
      /Chat not found/,
    );
    expect(adapters.postOmnigentMessage).not.toHaveBeenCalled();
  });
});

describe("chats.archiving", () => {
  it("reads the engine's value and writes the days it is given", async () => {
    adapters.getOmnigentArchiving.mockResolvedValue({
      side_chat_auto_archive_days: 7,
      default_days: 30,
    });
    await expect(run(chatsRouter.chats.archiving, { botId: "conv_super" })).resolves.toEqual({
      sideChatAutoArchiveDays: 7,
      defaultDays: 30,
    });
    adapters.putOmnigentArchiving.mockResolvedValue({
      side_chat_auto_archive_days: null,
      default_days: 30,
    });
    await run(chatsRouter.chats.updateArchiving, {
      botId: "conv_super",
      sideChatAutoArchiveDays: null,
    });
    expect(adapters.putOmnigentArchiving).toHaveBeenCalledWith(expect.anything(), "", {
      side_chat_auto_archive_days: null,
    });
  });
});
