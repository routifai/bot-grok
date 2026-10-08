import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adoptOmnigentMuse,
  answerOmnigentAsk,
  createOmnigentSideChat,
  forgetOmnigentMemoryClaim,
  getOmnigentComputer,
  getOmnigentMemoryProfile,
  getOmnigentMuse,
  getOmnigentProactivity,
  getOmnigentSession,
  getOmnigentTranscript,
  listOmnigentDailyNotes,
  listOmnigentFeed,
  listOmnigentMemoryClaims,
  OmnigentApiError,
  OmnigentSideChatError,
  omnigentErrorCopy,
  openOmnigentComputerScreen,
  patchOmnigentMemoryClaim,
  postOmnigentMessage,
  putOmnigentDailyNote,
  putOmnigentMuseAgent,
  putOmnigentProactivity,
  releaseOmnigentComputer,
  streamOmnigentFamily,
  streamOmnigentSession,
} from "./client.js";

const CONFIG = { baseUrl: "http://omnigent.test", proxySecret: "proxy-secret", tenant: "space-1" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("omnigent client", () => {
  it("sends identity, proxy secret and the tenant on every call", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ session_id: "conv_1", agent: "superchat", created: true }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const muse = await getOmnigentMuse(CONFIG, "person@example.test");

    expect(muse).toEqual({ session_id: "conv_1", agent: "superchat", created: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe("/v1/me/muse");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Forwarded-Email"]).toBe("person@example.test");
    expect(headers["X-Omnigent-Proxy-Secret"]).toBe("proxy-secret");
    expect(headers["X-Omnigent-Tenant"]).toBe("space-1");
  });

  it("switches and adopts the Muse through /v1/me/muse", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ session_id: "conv_1", agent: "superchat", created: false }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await putOmnigentMuseAgent(CONFIG, "e@x.test", "superchat");
    await adoptOmnigentMuse(CONFIG, "e@x.test", "conv_1");

    const [putUrl, putInit] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(putUrl.pathname).toBe("/v1/me/muse");
    expect(putInit.method).toBe("PUT");
    expect(JSON.parse(putInit.body as string)).toEqual({ agent: "superchat" });
    const [adoptUrl, adoptInit] = fetchMock.mock.calls[1] as unknown as [URL, RequestInit];
    expect(adoptUrl.pathname).toBe("/v1/me/muse/adopt");
    expect(JSON.parse(adoptInit.body as string)).toEqual({ session_id: "conv_1" });
  });

  it("carries the engine's error code, which has short copy where it reaches the UI", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: { code: "muse_already_set", message: "x" } }, 409)),
    );
    const error = await adoptOmnigentMuse(CONFIG, "e@x.test", "conv_1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OmnigentApiError);
    expect((error as OmnigentApiError).code).toBe("muse_already_set");
    expect(omnigentErrorCopy(error)).toBe("You already have a Conversation here.");
    expect(omnigentErrorCopy(new OmnigentApiError("x", "helper_read_only"))).toBe(
      "Helpers are read-only.",
    );
    expect(omnigentErrorCopy(new OmnigentApiError("x", "not_found"))).toBeUndefined();
  });

  it("answers an ask with its choice id and note", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await answerOmnigentAsk(CONFIG, "e@x.test", "task:obj_1:task_1", {
      choice: "answer",
      note: "Use the Q3 numbers",
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe("/v1/me/asks/task%3Aobj_1%3Atask_1/answer");
    expect(JSON.parse(init.body as string)).toEqual({
      choice: "answer",
      note: "Use the Q3 numbers",
    });
  });

  it("pages the feed with the engine's cursor", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ data: [], has_more: false, next_cursor: null }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await listOmnigentFeed(CONFIG, "e@x.test", { limit: 20, before: "100:run_1" });

    const [url] = fetchMock.mock.calls[0] as unknown as [URL];
    expect(url.pathname).toBe("/v1/me/feed");
    expect(url.searchParams.get("limit")).toBe("20");
    expect(url.searchParams.get("before")).toBe("100:run_1");
  });

  it("reads and writes proactivity on /v1/me/proactivity", async () => {
    const prefs = { proactivity: "high", quiet_start: null, quiet_end: null, timezone: "UTC" };
    const fetchMock = vi.fn(async () => jsonResponse(prefs));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getOmnigentProactivity(CONFIG, "e@x.test")).resolves.toEqual(prefs);
    await putOmnigentProactivity(CONFIG, "e@x.test", { proactivity: "high" });

    const [, init] = fetchMock.mock.calls[1] as unknown as [URL, RequestInit];
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ proactivity: "high" });
  });

  it("getOmnigentSession requests a cheap snapshot and returns host_id", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ id: "conv_1", status: "running", host_id: null }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await getOmnigentSession(CONFIG, "e@x.test", "conv_1");

    expect(snapshot.host_id).toBeNull();
    const [url] = fetchMock.mock.calls[0] as unknown as [URL];
    expect(url.pathname).toBe("/v1/sessions/conv_1");
    expect(url.searchParams.get("include_items")).toBe("false");
    expect(url.searchParams.get("include_liveness")).toBe("false");
    expect(url.searchParams.get("include_usage")).toBe("false");
  });

  it("postOmnigentMessage throws with a descriptive error on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "nope" }, 400)),
    );
    await expect(postOmnigentMessage(CONFIG, "e@x.test", "conv_1", "hi")).rejects.toThrow(
      /post message event failed \(400\)/,
    );
  });

  it("streamOmnigentSession yields parsed data frames and skips [DONE]/keepalives", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          'event: session.status\ndata: {"type":"session.status","data":{"status":"running"}}\n\n',
          ": keepalive\n\n",
          'event: response.completed\ndata: {"type":"response.completed","response":{"output":[]}}\n\n',
          "data: [DONE]\n\n",
        ]),
      ),
    );

    const events = [];
    for await (const event of streamOmnigentSession(CONFIG, "e@x.test", "conv_1")) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: "session.status", data: { status: "running" } },
      { type: "response.completed", response: { output: [] } },
    ]);
  });
});

describe("getOmnigentMemoryProfile", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads the Super Chat's profile and maps an empty one to null", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ profile: "" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getOmnigentMemoryProfile(CONFIG, "person@example.test", "conv_1");

    expect(result).toEqual({ profile: null });
    const [url] = fetchMock.mock.calls[0] as unknown as [URL];
    expect(String(url)).toBe("http://omnigent.test/v1/sessions/conv_1/memory/profile");
  });
});

describe("daily notes", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists the owner's notes and saves one with PUT", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ daily_notes: [], date: "2026-10-04" }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await listOmnigentDailyNotes(CONFIG, "p@example.test", 7)).toEqual([]);
    await putOmnigentDailyNote(CONFIG, "p@example.test", "2026-10-04", { decisions: "- x" });

    const [listUrl] = fetchMock.mock.calls[0] as unknown as [URL];
    expect(String(listUrl)).toBe("http://omnigent.test/v1/me/daily-notes?limit=7");
    const [putUrl, init] = fetchMock.mock.calls[1] as unknown as [URL, RequestInit];
    expect(String(putUrl)).toBe("http://omnigent.test/v1/me/daily-notes/2026-10-04");
    expect(init.method).toBe("PUT");
    expect(init.body).toBe(JSON.stringify({ sections: { decisions: "- x" } }));
  });
});

describe("throwOnError redaction (docs/super-chat/WIRING.md review item 5)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("redacts a secret value out of the error body before it reaches the thrown message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("request failed: Bearer sk-live-topsecret was rejected", { status: 500 }),
      ),
    );
    const config = { ...CONFIG, secrets: ["sk-live-topsecret"] };

    await expect(getOmnigentSession(config, "p@x.test", "conv_1")).rejects.toThrow(/\[redacted\]/);
    await expect(getOmnigentSession(config, "p@x.test", "conv_1")).rejects.not.toThrow(
      /sk-live-topsecret/,
    );
  });

  it("drops the body entirely when no secrets list is configured, rather than risking a leak", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("request failed: Bearer sk-live-topsecret", { status: 500 })),
    );

    await expect(getOmnigentSession(CONFIG, "p@x.test", "conv_1")).rejects.not.toThrow(
      /sk-live-topsecret/,
    );
  });
});

describe("createOmnigentSideChat error handling (docs/super-chat/WIRING.md review item 3)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sets conversationId on OmnigentSideChatError when the body shows the chat was created anyway", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ conversation_id: "conv_new", error: "first message failed" }, 502),
      ),
    );

    let caught: unknown;
    try {
      await createOmnigentSideChat(CONFIG, "p@x.test", "conv_super", { start: "blank" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OmnigentSideChatError);
    expect((caught as OmnigentSideChatError).conversationId).toBe("conv_new");
  });

  it("leaves conversationId null when the body never names one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("internal error", { status: 500 })),
    );

    let caught: unknown;
    try {
      await createOmnigentSideChat(CONFIG, "p@x.test", "conv_super", { start: "blank" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OmnigentSideChatError);
    expect((caught as OmnigentSideChatError).conversationId).toBeNull();
  });

  it("returns first_message_error through on a 2xx so the caller can retry the post", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          conversation_id: "conv_new",
          title: "t",
          start: "blank",
          first_message_error: "could not post",
        }),
      ),
    );

    const result = await createOmnigentSideChat(CONFIG, "p@x.test", "conv_super", {
      start: "blank",
      firstMessage: "hi",
    });
    expect(result.first_message_error).toBe("could not post");
  });

  it("computer calls hit the session-scoped routes with identity/proxy headers", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ available: true, in_control: false }))
      .mockResolvedValueOnce(jsonResponse({ screen_url: "http://127.0.0.1:1/x", in_control: true }))
      .mockResolvedValueOnce(
        jsonResponse({ screen_url: "http://127.0.0.1:1/y", in_control: false }),
      );
    vi.stubGlobal("fetch", fetchMock);

    expect(await getOmnigentComputer(CONFIG, "p@example.test", "s 1")).toEqual({
      available: true,
      in_control: false,
    });
    expect(
      (await openOmnigentComputerScreen(CONFIG, "p@example.test", "s 1", true)).in_control,
    ).toBe(true);
    expect((await releaseOmnigentComputer(CONFIG, "p@example.test", "s 1")).in_control).toBe(false);

    const calls = fetchMock.mock.calls as unknown as [URL, RequestInit][];
    expect(calls.map(([url, init]) => `${init?.method ?? "GET"} ${url.pathname}`)).toEqual([
      "GET /v1/sessions/s%201/computer",
      "POST /v1/sessions/s%201/computer/screen",
      "POST /v1/sessions/s%201/computer/release",
    ]);
    expect(JSON.parse(calls[1]![1].body as string)).toEqual({ interactive: true });
    expect((calls[0]![1].headers as Record<string, string>)["X-Omnigent-Proxy-Secret"]).toBe(
      "proxy-secret",
    );
  });
});

describe("memory claims", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists, edits with PATCH and forgets with confirm", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ claims: [] }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await listOmnigentMemoryClaims(CONFIG, "p@example.test", "s1")).toEqual([]);
    await patchOmnigentMemoryClaim(CONFIG, "p@example.test", "s1", "c1", "Maya, manager");
    await forgetOmnigentMemoryClaim(CONFIG, "p@example.test", "s1", "c1");

    const [listUrl] = fetchMock.mock.calls[0] as unknown as [URL];
    expect(String(listUrl)).toBe("http://omnigent.test/v1/sessions/s1/memory/claims");
    const [patchUrl, patch] = fetchMock.mock.calls[1] as unknown as [URL, RequestInit];
    expect(String(patchUrl)).toBe("http://omnigent.test/v1/sessions/s1/memory/claims/c1");
    expect(patch.method).toBe("PATCH");
    expect(patch.body).toBe(JSON.stringify({ text: "Maya, manager" }));
    const [, forget] = fetchMock.mock.calls[2] as unknown as [URL, RequestInit];
    expect(forget.body).toBe(JSON.stringify({ claim_id: "c1", confirm: true }));
  });
});

describe("transcript and family stream", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads one transcript page with its cursor and seed flag", async () => {
    const page = {
      data: [],
      has_more: false,
      older_cursor: null,
      lineage: { kind: "super", root_id: "s1", parent_id: null, seed_item_id: null },
    };
    const fetchMock = vi.fn(async () => jsonResponse(page));
    vi.stubGlobal("fetch", fetchMock);

    expect(
      await getOmnigentTranscript(CONFIG, "p@example.test", "s 1", {
        limit: 20,
        before: "i9",
        includeSeed: true,
      }),
    ).toEqual(page);

    const [url] = fetchMock.mock.calls[0] as unknown as [URL];
    expect(String(url)).toBe(
      "http://omnigent.test/v1/sessions/s%201/transcript?limit=20&before=i9&include_seed=true",
    );
  });

  it("yields the family events and ignores any other frame", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        'event: message.done\ndata: {"type":"message.done","chat_id":"c1","item_id":"i1"}\n\n',
        'event: other\ndata: {"type":"other"}\n\n',
        'event: session.heartbeat\ndata: {"type":"session.heartbeat"}\n\n',
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const events = [];
    for await (const event of streamOmnigentFamily(CONFIG, "p@example.test", "s1")) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "message.done", chat_id: "c1", item_id: "i1" },
      { type: "session.heartbeat" },
    ]);
    const [url] = fetchMock.mock.calls[0] as unknown as [URL];
    expect(String(url)).toBe("http://omnigent.test/v1/sessions/s1/family/stream");
  });
});
