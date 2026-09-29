import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOmnigentHostDirectory,
  createOmnigentSession,
  findOmnigentAgentIdByName,
  getOmnigentSession,
  listOmnigentHostDirectory,
  listOmnigentHosts,
  postOmnigentMessage,
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

  it("listOmnigentHosts returns the caller's hosts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          hosts: [
            {
              host_id: "host_1",
              name: "laptop",
              owner: "e@x.test",
              status: "online",
              sandbox_provider: null,
            },
          ],
        }),
      ),
    );
    const hosts = await listOmnigentHosts(CONFIG, "e@x.test");
    expect(hosts).toEqual([
      {
        host_id: "host_1",
        name: "laptop",
        owner: "e@x.test",
        status: "online",
        sandbox_provider: null,
      },
    ]);
  });

  it("createOmnigentHostDirectory posts the tilde path and returns the created absolute path", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ object: "directory", path: "/Users/person/nova/bot-1" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await createOmnigentHostDirectory(CONFIG, "e@x.test", "host_1", "~/nova/bot-1");

    expect(result.path).toBe("/Users/person/nova/bot-1");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe("/v1/hosts/host_1/directories");
    expect(JSON.parse(init.body as string)).toEqual({ path: "~/nova/bot-1" });
  });

  it("createOmnigentHostDirectory throws with a descriptive error when the directory already exists", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "directory already exists" }, 409)),
    );
    await expect(
      createOmnigentHostDirectory(CONFIG, "e@x.test", "host_1", "~/nova/bot-1"),
    ).rejects.toThrow(/create host directory failed \(409\)/);
  });

  it("listOmnigentHostDirectory lists a directory's entries with absolute paths", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        object: "list",
        data: [{ name: "bot-1", path: "/Users/person/nova/bot-1", type: "directory" }],
        has_more: false,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const entries = await listOmnigentHostDirectory(CONFIG, "e@x.test", "host_1", "~/nova");

    expect(entries).toEqual([
      { name: "bot-1", path: "/Users/person/nova/bot-1", type: "directory" },
    ]);
    const [url] = fetchMock.mock.calls[0] as unknown as [URL];
    expect(url.pathname).toBe("/v1/hosts/host_1/filesystem/~/nova");
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
