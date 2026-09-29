import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOmnigentSession,
  findOmnigentAgentIdByName,
  postOmnigentMessage,
  streamOmnigentSession,
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
