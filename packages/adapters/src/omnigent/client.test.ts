import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOmnigentSession,
  createOmnigentSideChat,
  findOmnigentAgentIdByName,
  forgetOmnigentMemoryClaim,
  getOmnigentComputer,
  getOmnigentMemoryProfile,
  getOmnigentSession,
  getOmnigentTranscript,
  listOmnigentDailyNotes,
  listOmnigentMemoryClaims,
  OmnigentSideChatError,
  openOmnigentComputerScreen,
  patchOmnigentMemoryClaim,
  postOmnigentMessage,
  putOmnigentDailyNote,
  releaseOmnigentComputer,
  streamOmnigentFamily,
  streamOmnigentSession,
  switchOmnigentAgent,
} from "./client.js";

const CONFIG = { baseUrl: "http://omnigent.test", proxySecret: "proxy-secret" };

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
  it("createOmnigentSession sends identity/proxy headers and the agent id + labels", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: "conv_1", status: "running" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await createOmnigentSession(CONFIG, "person@example.test", {
      agentId: "ag_1",
      labels: { "nova.scope": "private" },
    });

    expect(result.id).toBe("conv_1");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe("/v1/sessions");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-Forwarded-Email"]).toBe(
      "person@example.test",
    );
    expect((init.headers as Record<string, string>)["X-Omnigent-Proxy-Secret"]).toBe(
      "proxy-secret",
    );
    expect(JSON.parse(init.body as string)).toMatchObject({
      agent_id: "ag_1",
      labels: { "nova.scope": "private" },
    });
  });

  it("createOmnigentSession sends host_type/sandbox_provider for a managed runner binding", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: "conv_1", status: "running" }));
    vi.stubGlobal("fetch", fetchMock);

    await createOmnigentSession(CONFIG, "person@example.test", {
      agentId: "ag_1",
      labels: {},
      hostType: "managed",
      sandboxProvider: "computer",
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.host_type).toBe("managed");
    expect(body.sandbox_provider).toBe("computer");
    expect(body).not.toHaveProperty("host_id");
    expect(body).not.toHaveProperty("workspace");
  });

  it("createOmnigentSession sends host_id/workspace for an external runner binding", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: "conv_1", status: "running" }));
    vi.stubGlobal("fetch", fetchMock);

    await createOmnigentSession(CONFIG, "person@example.test", {
      agentId: "ag_1",
      labels: {},
      hostType: "external",
      hostId: "host_1",
      workspace: "/Users/person/nova/bot-1",
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.host_type).toBe("external");
    expect(body.host_id).toBe("host_1");
    expect(body.workspace).toBe("/Users/person/nova/bot-1");
    expect(body).not.toHaveProperty("sandbox_provider");
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

  it("findOmnigentAgentIdByName finds a matching agent by name", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          data: [
            { id: "ag_1", name: "nova-pi" },
            { id: "ag_2", name: "nova-claude" },
          ],
        }),
      ),
    );
    await expect(findOmnigentAgentIdByName(CONFIG, "e@x.test", "nova-claude")).resolves.toBe(
      "ag_2",
    );
    await expect(findOmnigentAgentIdByName(CONFIG, "e@x.test", "missing")).resolves.toBeUndefined();
  });

  it("switchOmnigentAgent posts the target agent id to the switch-agent endpoint", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: "conv_1", status: "idle" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await switchOmnigentAgent(CONFIG, "person@example.test", "conv_1", "ag_2");

    expect(result.status).toBe("idle");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe("/v1/sessions/conv_1/switch-agent");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ agent_id: "ag_2" });
  });

  it("switchOmnigentAgent throws with a descriptive error on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "busy" }, 409)),
    );
    await expect(switchOmnigentAgent(CONFIG, "e@x.test", "conv_1", "ag_2")).rejects.toThrow(
      /switch agent failed \(409\)/,
    );
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
