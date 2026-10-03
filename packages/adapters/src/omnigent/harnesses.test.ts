import { describe, expect, it } from "vitest";
import {
  agentNameForHarnessId,
  agentNameForMuseHarness,
  defaultHarnessId,
  harnessIdForAgentName,
  isNovaHarnessId,
  listNovaHarnesses,
  resolveMuseHarnessId,
} from "./harnesses.js";

describe("listNovaHarnesses availability", () => {
  it("marks claude available only from ANTHROPIC_API_KEY", () => {
    const [claude] = listNovaHarnesses({});
    expect(claude).toMatchObject({
      id: "claude",
      available: false,
      unavailableReason: "Add ANTHROPIC_API_KEY to .env",
    });

    const [claudeAvailable] = listNovaHarnesses({ ANTHROPIC_API_KEY: "sk-ant" });
    expect(claudeAvailable).toMatchObject({
      id: "claude",
      available: true,
      unavailableReason: null,
    });
  });

  it("returns one entry: the Claude Super Chat bundle", () => {
    const harnesses = listNovaHarnesses({});
    expect(harnesses.map((harness) => [harness.id, harness.agentName])).toEqual([
      ["claude", "nova-claude"],
    ]);
  });
});

describe("harness id / agent name mapping", () => {
  it("round-trips harness id -> agent name -> harness id", () => {
    expect(harnessIdForAgentName(agentNameForHarnessId("claude"))).toBe("claude");
  });

  it("falls back to claude for an unrecognized agent bundle name", () => {
    expect(harnessIdForAgentName("some-other-bundle")).toBe("claude");
    expect(harnessIdForAgentName("nova-pi")).toBe("claude");
  });

  it("isNovaHarnessId rejects values outside the catalog", () => {
    expect(isNovaHarnessId("claude")).toBe(true);
    expect(isNovaHarnessId("pi")).toBe(false);
    expect(isNovaHarnessId("gpt5")).toBe(false);
  });
});

describe("defaultHarnessId / resolveMuseHarnessId", () => {
  it("defaults to claude when OMNIGENT_AGENT_NAME is unset", () => {
    expect(defaultHarnessId({})).toBe("claude");
  });

  it("follows OMNIGENT_AGENT_NAME for backwards compatibility", () => {
    expect(defaultHarnessId({ OMNIGENT_AGENT_NAME: "nova-claude" })).toBe("claude");
  });

  it("falls back to the deployment default when museHarness is null", () => {
    expect(resolveMuseHarnessId(null, { OMNIGENT_AGENT_NAME: "nova-claude" })).toBe("claude");
  });

  it("falls back to the deployment default when museHarness names a retired harness", () => {
    expect(resolveMuseHarnessId("pi", {})).toBe("claude");
  });
});

describe("agentNameForMuseHarness", () => {
  it("uses the bot's own choice when set and valid", () => {
    expect(agentNameForMuseHarness("claude", "nova-claude")).toBe("nova-claude");
  });

  it("falls back to the gateway's resolved default when unset or retired", () => {
    expect(agentNameForMuseHarness(null, "nova-claude")).toBe("nova-claude");
    expect(agentNameForMuseHarness("pi", "nova-claude")).toBe("nova-claude");
  });
});
