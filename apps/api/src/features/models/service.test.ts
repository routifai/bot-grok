import type { ORPCError } from "@orpc/server";
import type { PrismaClient } from "@superchat/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectEngineModel,
  engineModelsStatus,
  engineSessionModel,
  listEngineProviders,
  setEngineDefaultModel,
  setEngineLightModel,
} from "./service.js";

const client = { baseUrl: "http://engine.test", proxySecret: "proxy", secrets: [], tenant: "s1" };
const actor = { userId: "user-1", spaceId: "s1" } as never;
const deps = (agentName: string | null = "superchat-pi") => ({
  prisma: {
    user: { findUnique: vi.fn(async () => ({ email: "p@example.test" })) },
    bot: {
      findFirst: vi.fn(async () => ({
        omnigentSession: agentName ? { omnigentSessionId: "sess-1", agentName } : null,
      })),
    },
    omnigentSession: { findFirst: vi.fn(async () => (agentName ? { agentName } : null)) },
  } as unknown as PrismaClient,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const failure = (status: number, code: string, message: string) =>
  json({ error: { code, message } }, status);

const catalog = (status = "ready") => ({
  harness: "pi",
  status,
  provider_label: "Anthropic",
  default_model: "claude-sonnet",
  models: [
    {
      id: "claude-sonnet",
      label: "Sonnet",
      family: "sonnet",
      is_default: true,
      is_user_default: false,
    },
  ],
});

function stub(handler: (url: URL, init?: RequestInit) => Response) {
  const fetchMock = vi.fn(async (url: URL, init?: RequestInit) => handler(url, init));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function rejection(promise: Promise<unknown>): Promise<ORPCError<string, { code: string }>> {
  try {
    await promise;
  } catch (error) {
    return error as ORPCError<string, { code: string }>;
  }
  throw new Error("expected a rejection");
}

afterEach(() => vi.unstubAllGlobals());

describe("engine models status", () => {
  it("is disabled without the engine", async () => {
    expect(await engineModelsStatus(deps(), undefined, actor)).toEqual({
      enabled: false,
      harnesses: [],
      ready: false,
    });
  });

  it("names the harness the Muse runs on and reports readiness", async () => {
    stub(() => json(catalog()));
    const status = await engineModelsStatus(deps("superchat-pi"), client, actor);
    expect(status).toEqual({
      enabled: true,
      harnesses: [{ id: "pi", label: "Pi" }],
      ready: true,
    });
  });

  it("offers both harnesses before a Muse exists and is not ready without a key", async () => {
    stub(() => json(catalog("needs_key")));
    const status = await engineModelsStatus(deps(null), client, actor);
    expect(status.harnesses.map((h) => h.id)).toEqual(["claude-sdk", "pi"]);
    expect(status.ready).toBe(false);
  });
});

describe("personal model calls", () => {
  it("lists the providers the engine has configured, in its order", async () => {
    const fetchMock = stub(() =>
      json({
        data: [
          { provider: "openrouter", label: "OpenRouter", operator_key: true },
          { provider: "anthropic", label: "Anthropic", operator_key: false },
        ],
      }),
    );
    expect(await listEngineProviders(deps(), client, actor)).toEqual([
      { provider: "openrouter", label: "OpenRouter", operatorKey: true },
      { provider: "anthropic", label: "Anthropic", operatorKey: false },
    ]);
    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(url.pathname).toBe("/v1/me/model-providers");
  });

  it("saves a key as the person and returns masked metadata only", async () => {
    const fetchMock = stub(() =>
      json({
        provider: "anthropic",
        hint: "...abcd",
        status: "valid",
        validated_at: 9,
        label: null,
        scope: "user",
      }),
    );
    const result = await connectEngineModel(deps(), client, actor, {
      provider: "anthropic",
      apiKey: "sk-secret",
    });
    expect(result).toEqual({
      provider: "anthropic",
      hint: "...abcd",
      status: "valid",
      validatedAt: 9,
      label: null,
      scope: "user",
    });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe("/v1/me/model-connections/anthropic");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ api_key: "sk-secret" });
    expect((init.headers as Record<string, string>)["X-Forwarded-Email"]).toBe("p@example.test");
  });

  it("shows the provider's rejection of a key as the message, with the engine code", async () => {
    stub(() => failure(400, "invalid_input", "Anthropic rejected this key"));
    const error = await rejection(
      connectEngineModel(deps(), { ...client, secrets: ["x"] }, actor, {
        provider: "anthropic",
        apiKey: "bad",
      }),
    );
    expect(error.code).toBe("BAD_REQUEST");
    expect(error.message).toBe("Anthropic rejected this key");
    expect(error.data).toEqual({ code: "invalid_input" });
  });

  it.each([
    [412, "model_key_required", "PRECONDITION_FAILED", "Add your API key to continue."],
    [403, "account_suspended", "FORBIDDEN", "Your account is paused. Contact your admin."],
    [402, "model_budget_exhausted", "FORBIDDEN", "You've reached your monthly model budget."],
    [400, "model_not_supported", "BAD_REQUEST", "This model isn't available — pick another."],
    [
      502,
      "model_provider_unreachable",
      "BAD_GATEWAY",
      "Couldn't reach the model provider. Try again.",
    ],
  ])("maps %s %s to a typed error", async (status, code, orpc, message) => {
    stub(() => failure(status as number, code as string, "engine text that is not shown"));
    const error = await rejection(
      setEngineDefaultModel(deps(), { ...client, secrets: [] }, actor, {
        harness: "pi",
        model: "m",
      }),
    );
    expect(error.code).toBe(orpc);
    expect(error.message).toBe(message);
    expect(error.data).toEqual({ code });
  });

  it("keeps the person's other harness defaults when setting one", async () => {
    const fetchMock = stub((_url, init) =>
      json({
        defaults:
          init?.method === "PUT" ? { "claude-sdk": "opus", pi: "m" } : { "claude-sdk": "opus" },
      }),
    );
    expect(
      await setEngineDefaultModel(deps(), client, actor, { harness: "pi", model: "m" }),
    ).toEqual({
      "claude-sdk": "opus",
      pi: "m",
    });
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT") as [
      URL,
      RequestInit,
    ];
    expect(JSON.parse(String(put[1].body))).toEqual({
      defaults: { "claude-sdk": "opus", pi: "m" },
    });
  });

  it("sets one harness's Light model, or sends it back to automatic, keeping the others", async () => {
    const puts: unknown[] = [];
    stub((_url, init) => {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { light: Record<string, string> };
        puts.push(body);
        return json({ defaults: {}, light: body.light });
      }
      return json({ defaults: { pi: "big" }, light: { "claude-sdk": "haiku", pi: "old" } });
    });
    expect(
      await setEngineLightModel(deps(), client, actor, { harness: "pi", model: "small" }),
    ).toEqual({ "claude-sdk": "haiku", pi: "small" });
    expect(
      await setEngineLightModel(deps(), client, actor, { harness: "pi", model: null }),
    ).toEqual({ "claude-sdk": "haiku" });
    // Only the Light map is sent: the engine keeps the defaults as they are.
    expect(puts).toEqual([
      { light: { "claude-sdk": "haiku", pi: "small" } },
      { light: { "claude-sdk": "haiku" } },
    ]);
  });

  it("maps the Light model the engine resolved onto the catalog", async () => {
    stub(() =>
      json({
        ...catalog(),
        light_model: "claude-sonnet",
        light_pick: null,
        automatic_light_model: "claude-sonnet",
        models: [{ ...catalog().models[0], is_light: true }],
      }),
    );
    const { catalog: mapped } = await engineSessionModel(deps(null), client, actor, "bot-1");
    expect(mapped.lightModel).toBe("claude-sonnet");
    expect(mapped.lightPick).toBeNull();
    expect(mapped.automaticLightModel).toBe("claude-sonnet");
    expect(mapped.models[0]?.isLight).toBe(true);
  });

  it("reads the Conversation's pinned model with the list for its harness", async () => {
    stub((url) =>
      url.pathname === "/v1/sessions/sess-1"
        ? json({ model_override: "claude-sonnet" })
        : json(catalog()),
    );
    const result = await engineSessionModel(deps("superchat-pi"), client, actor, "bot-1");
    expect(result.harness).toBe("pi");
    expect(result.model).toBe("claude-sonnet");
    expect(result.catalog.models[0]?.family).toBe("sonnet");
  });
});
