import type { PrismaClient, ThreadEvents } from "@aiden/db";
import { describe, expect, it } from "vitest";
import {
  museAgentNameFromEnv,
  omnigentClientConfigFromEnv,
  omnigentGatewayDepsFromEnv,
} from "./env.js";

const prisma = {} as PrismaClient;
const events = {} as ThreadEvents;

describe("omnigent connection env", () => {
  it("is off when neither connection var is set", () => {
    expect(omnigentGatewayDepsFromEnv({}, prisma, events, [])).toBeUndefined();
    expect(omnigentClientConfigFromEnv({})).toBeUndefined();
  });

  it("is on whenever the URL and proxy secret are both set", () => {
    const env = { OMNIGENT_URL: " http://omnigent.test ", OMNIGENT_PROXY_SECRET: "s" };
    const deps = omnigentGatewayDepsFromEnv(env, prisma, events, []);
    expect(deps?.client.baseUrl).toBe("http://omnigent.test");
    expect(deps?.agentName).toBe("nova-claude");
    expect(omnigentClientConfigFromEnv(env)?.proxySecret).toBe("s");
  });

  it("fails loud at boot on a half-configured connection", () => {
    expect(() =>
      omnigentGatewayDepsFromEnv({ OMNIGENT_URL: "http://x" }, prisma, events, []),
    ).toThrow("OMNIGENT_PROXY_SECRET");
    expect(() =>
      omnigentGatewayDepsFromEnv({ OMNIGENT_PROXY_SECRET: "s" }, prisma, events, []),
    ).toThrow("OMNIGENT_URL");
    expect(omnigentClientConfigFromEnv({ OMNIGENT_URL: "http://x" })).toBeUndefined();
  });

  it("NOVA_MUSE_HARNESS picks the Muse bundle; an explicit agent name wins", () => {
    expect(museAgentNameFromEnv({})).toBe("nova-claude");
    expect(museAgentNameFromEnv({ NOVA_MUSE_HARNESS: "claude-sdk" })).toBe("nova-claude");
    expect(museAgentNameFromEnv({ NOVA_MUSE_HARNESS: " PI " })).toBe("nova-pi");
    expect(museAgentNameFromEnv({ NOVA_MUSE_HARNESS: "pi", OMNIGENT_AGENT_NAME: "x" })).toBe("x");
    expect(() => museAgentNameFromEnv({ NOVA_MUSE_HARNESS: "codex" })).toThrow("NOVA_MUSE_HARNESS");
  });
});
