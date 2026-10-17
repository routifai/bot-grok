import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./client", () => ({
  engineClient: () => ({ baseUrl: "http://engine.test", proxySecret: "", secrets: [] }),
  museSessionId: async () => "muse-1",
  NO_EMAIL: "",
}));

const { engineModelsRouter } = await import("./models");
const { call } = await import("@orpc/server");

function stubEngine(...responses: { status?: number; body: unknown }[]) {
  const fetchMock = vi.fn();
  for (const { status = 200, body } of responses) {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const setHarness = (harness: "claude-sdk" | "pi") =>
  call(engineModelsRouter.engineModels.setHarness, { harness });

afterEach(() => vi.unstubAllGlobals());

describe("setHarness", () => {
  it("runs the Superchat on the harness's built-in agent", async () => {
    const fetchMock = stubEngine({
      body: { session_id: "muse-1", agent: "superchat-pi", created: false },
    });
    expect(await setHarness("pi")).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe("/v1/me/muse");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ agent: "superchat-pi" });
  });

  it("asks the person to finish the reply while one runs", async () => {
    stubEngine({
      status: 409,
      body: { error: { code: "conflict", message: "Session is busy" } },
    });
    await expect(setHarness("claude-sdk")).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Finish or stop the current reply first.",
      data: { code: "conflict" },
    });
  });
});

describe("status", () => {
  it("names the one harness the Superchat runs on", async () => {
    stubEngine(
      { body: { session_id: "muse-1", agent: "superchat-pi", created: false } },
      { body: { harness: "pi", status: "ready", default_model: null, models: [] } },
    );
    expect(await call(engineModelsRouter.engineModels.status, undefined)).toEqual({
      enabled: true,
      harnesses: [{ id: "pi", label: "Pi" }],
      ready: true,
    });
  });
});
