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
  it("marks pi available from OPENROUTER_API_KEY", () => {
    const [pi] = listNovaHarnesses({ OPENROUTER_API_KEY: "sk-1" });
    expect(pi).toMatchObject({ id: "pi", available: true, unavailableReason: null });
  });

  it("marks pi available from AIDEN_LOCAL_MODELS_URL alone", () => {
    const [pi] = listNovaHarnesses({ AIDEN_LOCAL_MODELS_URL: "http://localhost:4000" });
    expect(pi).toMatchObject({ id: "pi", available: true, unavailableReason: null });
  });

  it("marks pi unavailable and names the missing variable otherwise", () => {
    const [pi] = listNovaHarnesses({});
    expect(pi).toMatchObject({
      id: "pi",
      available: false,
      unavailableReason: "Add OPENROUTER_API_KEY to .env",
    });
  });

  it("marks claude available only from ANTHROPIC_API_KEY", () => {
    const harnesses = listNovaHarnesses({});
    const claude = harnesses.find((harness) => harness.id === "claude");
    expect(claude).toMatchObject({
      available: false,
      unavailableReason: "Add ANTHROPIC_API_KEY to .env",
    });

    const [, claudeAvailable] = listNovaHarnesses({ ANTHROPIC_API_KEY: "sk-ant" });
    expect(claudeAvailable).toMatchObject({ id: "claude", available: true });
  });

  it("marks openai and codex available only from OPENAI_API_KEY", () => {
    const withoutKey = listNovaHarnesses({});
    const openai = withoutKey.find((harness) => harness.id === "openai");
    const codex = withoutKey.find((harness) => harness.id === "codex");
    expect(openai).toMatchObject({
      available: false,
      unavailableReason: "Add OPENAI_API_KEY to .env",
    });
    expect(codex).toMatchObject({
      available: false,
      unavailableReason: "Add OPENAI_API_KEY to .env",
    });

    const withKey = listNovaHarnesses({ OPENAI_API_KEY: "sk-openai" });
    expect(withKey.find((harness) => harness.id === "openai")).toMatchObject({ available: true });
    expect(withKey.find((harness) => harness.id === "codex")).toMatchObject({ available: true });
  });

  it("returns one entry per NovaHarnessId with the documented agent bundle names", () => {
    const harnesses = listNovaHarnesses({});
    expect(harnesses.map((harness) => [harness.id, harness.agentName])).toEqual([
      ["pi", "nova-pi"],
      ["claude", "nova-claude"],
      ["openai", "nova-openai"],
      ["codex", "nova-codex"],
    ]);
  });
});

describe("harness id / agent name mapping", () => {
  it("round-trips harness id -> agent name -> harness id", () => {
    for (const id of ["pi", "claude", "openai", "codex"] as const) {
      expect(harnessIdForAgentName(agentNameForHarnessId(id))).toBe(id);
    }
  });

  it("falls back to pi for an unrecognized agent bundle name", () => {
    expect(harnessIdForAgentName("some-other-bundle")).toBe("pi");
  });

  it("isNovaHarnessId rejects values outside the catalog", () => {
    expect(isNovaHarnessId("pi")).toBe(true);
    expect(isNovaHarnessId("gpt5")).toBe(false);
  });
});

describe("defaultHarnessId / resolveMuseHarnessId", () => {
  it("defaults to pi when OMNIGENT_AGENT_NAME is unset", () => {
    expect(defaultHarnessId({})).toBe("pi");
  });

  it("follows OMNIGENT_AGENT_NAME for backwards compatibility", () => {
    expect(defaultHarnessId({ OMNIGENT_AGENT_NAME: "nova-claude" })).toBe("claude");
  });

  it("resolves a bot's own museHarness choice over the deployment default", () => {
    expect(resolveMuseHarnessId("codex", { OMNIGENT_AGENT_NAME: "nova-claude" })).toBe("codex");
  });

  it("falls back to the deployment default when museHarness is null", () => {
    expect(resolveMuseHarnessId(null, { OMNIGENT_AGENT_NAME: "nova-claude" })).toBe("claude");
  });
});

describe("agentNameForMuseHarness", () => {
  it("uses the bot's own choice when set and valid", () => {
    expect(agentNameForMuseHarness("openai", "nova-pi")).toBe("nova-openai");
  });

  it("falls back to the gateway's resolved default when unset", () => {
    expect(agentNameForMuseHarness(null, "nova-pi")).toBe("nova-pi");
  });
});
