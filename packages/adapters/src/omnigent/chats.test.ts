import { describe, expect, it, vi } from "vitest";
import {
  createChatOwnershipResolver,
  deriveSideChatTitle,
  mapRelatedChatToSummary,
  mapSideChatCreateToSummary,
  resolveChatOwnership,
  sideChatStartToWire,
} from "./chats.js";
import { OmnigentApiError } from "./client/core.js";

const { getOmnigentSession, listOmnigentRelatedChats } = vi.hoisted(() => ({
  getOmnigentSession: vi.fn(),
  listOmnigentRelatedChats: vi.fn(),
}));

vi.mock("./client.js", () => ({
  getOmnigentSession,
  listOmnigentRelatedChats,
}));

const CLIENT = { baseUrl: "http://omnigent.test", proxySecret: "secret" };
const EMAIL = "person@example.test";

describe("sideChatStartToWire", () => {
  it("maps withContext/blank to with_context/blank", () => {
    expect(sideChatStartToWire("withContext")).toBe("with_context");
    expect(sideChatStartToWire("blank")).toBe("blank");
  });
});

describe("mapRelatedChatToSummary", () => {
  it("maps with_context, archived, and live through", () => {
    expect(
      mapRelatedChatToSummary({
        id: "conv_1",
        title: "Q4 checklist",
        created_at: 1_700_000_000,
        updated_at: 1_700_000_100,
        last_message_preview: "ok",
        archived: true,
        start: "with_context",
        summary: "[framing] A seed summary",
        summary_body: "A seed summary",
        live: true,
      }),
    ).toEqual({
      id: "conv_1",
      title: "Q4 checklist",
      start: "withContext",
      summary: "A seed summary",
      archived: true,
      live: true,
      updatedAt: new Date(1_700_000_100 * 1000).toISOString(),
    });
  });

  it("maps blank start and defaults missing fields", () => {
    const mapped = mapRelatedChatToSummary({
      id: "conv_2",
      title: null,
      created_at: 0,
      updated_at: 0,
      last_message_preview: null,
      start: "blank",
    });
    expect(mapped.start).toBe("blank");
    expect(mapped.title).toBe("");
    expect(mapped.summary).toBeNull();
    expect(mapped.archived).toBe(false);
    expect(mapped.live).toBe(false);
  });

  it("treats a null/missing start as withContext (docs/super-chat/WIRING.md)", () => {
    const mapped = mapRelatedChatToSummary({
      id: "conv_3",
      title: "t",
      created_at: 0,
      updated_at: 0,
      last_message_preview: null,
      start: null,
    });
    expect(mapped.start).toBe("withContext");
  });
});

describe("deriveSideChatTitle", () => {
  it("keeps a short message as-is", () => {
    expect(deriveSideChatTitle("lunch ideas")).toBe("lunch ideas");
  });

  it("truncates a long message to ~40 characters with an ellipsis", () => {
    const long = "a".repeat(80);
    const title = deriveSideChatTitle(long);
    expect(title.length).toBeLessThanOrEqual(41);
    expect(title.endsWith("…")).toBe(true);
  });

  it("collapses internal whitespace before measuring", () => {
    expect(deriveSideChatTitle("  hello   world  ")).toBe("hello world");
  });
});

describe("mapSideChatCreateToSummary", () => {
  it("fills in archived:false and live:true for a freshly created chat", () => {
    const mapped = mapSideChatCreateToSummary(
      { conversation_id: "conv_new", title: "My title", start: "blank" },
      "ignored since title was returned",
    );
    expect(mapped).toMatchObject({
      id: "conv_new",
      title: "My title",
      start: "blank",
      summary: null,
      archived: false,
      live: true,
    });
  });

  it("derives a title from the first message when Omnigent returns none", () => {
    const mapped = mapSideChatCreateToSummary(
      { conversation_id: "conv_new", title: null, start: "with_context" },
      "what should I do about the Q4 numbers",
    );
    expect(mapped.title).toBe("what should I do about the Q4 numbers");
    expect(mapped.start).toBe("withContext");
  });
});

describe("resolveChatOwnership", () => {
  const superChats = [{ botId: "bot-1", omnigentSessionId: "conv_super" }];

  it("resolves a direct Side Chat via related_chats", async () => {
    listOmnigentRelatedChats.mockResolvedValue({
      data: [
        {
          id: "conv_side",
          title: "t",
          created_at: 0,
          updated_at: 0,
          last_message_preview: null,
          live: true,
        },
      ],
    });
    const ownership = await resolveChatOwnership(CLIENT, EMAIL, superChats, "conv_side");
    expect(ownership).toEqual({
      kind: "side_chat",
      superSessionId: "conv_super",
      botId: "bot-1",
      live: true,
    });
  });

  it("resolves a Helper one hop below the Super Chat", async () => {
    listOmnigentRelatedChats.mockResolvedValue({ data: [] });
    getOmnigentSession.mockResolvedValue({ id: "conv_helper", parent_session_id: "conv_super" });
    const ownership = await resolveChatOwnership(CLIENT, EMAIL, superChats, "conv_helper");
    expect(ownership).toEqual({ kind: "helper", superSessionId: "conv_super", botId: "bot-1" });
  });

  it("resolves a Helper launched from a Side Chat (Side Chats are top-level sessions)", async () => {
    listOmnigentRelatedChats.mockResolvedValue({
      data: [
        { id: "conv_side", title: "t", created_at: 0, updated_at: 0, last_message_preview: null },
      ],
    });
    getOmnigentSession.mockImplementation(async (_client: unknown, _email: string, id: string) => {
      if (id === "conv_nested_helper") return { id, parent_session_id: "conv_side" };
      return { id, parent_session_id: null };
    });
    const ownership = await resolveChatOwnership(CLIENT, EMAIL, superChats, "conv_nested_helper");
    expect(ownership).toEqual({ kind: "helper", superSessionId: "conv_super", botId: "bot-1" });
  });

  it("returns null (not found) past the hop limit or outside the caller's own Super Chats", async () => {
    listOmnigentRelatedChats.mockResolvedValue({ data: [] });
    getOmnigentSession.mockResolvedValue({ id: "x", parent_session_id: null });
    const ownership = await resolveChatOwnership(CLIENT, EMAIL, superChats, "conv_strangers");
    expect(ownership).toBeNull();
  });

  it("a resolver fetches related chats once and each parent hop once, however many chats", async () => {
    listOmnigentRelatedChats.mockClear();
    getOmnigentSession.mockClear();
    listOmnigentRelatedChats.mockResolvedValue({ data: [] });
    getOmnigentSession.mockImplementation(async (_c: unknown, _e: string, id: string) => ({
      id,
      parent_session_id: id === "conv_h1" ? "conv_h2" : "conv_super",
    }));
    const resolve = createChatOwnershipResolver(CLIENT, EMAIL, superChats);
    const found = await Promise.all(["conv_h1", "conv_h2", "conv_h1", "conv_h2"].map(resolve));
    expect(found.every((o) => o?.kind === "helper" && o.botId === "bot-1")).toBe(true);
    expect(listOmnigentRelatedChats).toHaveBeenCalledTimes(1);
    expect(getOmnigentSession).toHaveBeenCalledTimes(2);
  });

  it("treats a session the engine no longer has as unowned but surfaces other failures", async () => {
    listOmnigentRelatedChats.mockResolvedValue({ data: [] });
    getOmnigentSession.mockRejectedValueOnce(new OmnigentApiError("gone (404)", "not_found"));
    expect(await resolveChatOwnership(CLIENT, EMAIL, superChats, "conv_gone")).toBeNull();
    getOmnigentSession.mockRejectedValueOnce(new OmnigentApiError("boom (500)", undefined));
    await expect(resolveChatOwnership(CLIENT, EMAIL, superChats, "conv_x")).rejects.toThrow("boom");
  });

  it("never resolves the Super Chat's own id as a chat", async () => {
    listOmnigentRelatedChats.mockResolvedValue({ data: [] });
    getOmnigentSession.mockResolvedValue({ id: "conv_super", parent_session_id: null });
    const ownership = await resolveChatOwnership(CLIENT, EMAIL, superChats, "conv_super");
    expect(ownership).toBeNull();
  });
});
