import { describe, expect, it } from "vitest";
import { resolveDeploymentModel } from "./deployment-model.js";

describe("resolveDeploymentModel", () => {
  it("pairs the deployment model key with the provider it belongs to", () => {
    const both = { OPENROUTER_API_KEY: "or-key", ANTHROPIC_API_KEY: "sk-ant-key" };
    expect(resolveDeploymentModel(both)).toEqual({
      provider: "openrouter",
      model: "openai/gpt-5.6-luna",
      key: "or-key",
    });
    // The whole point: switching the provider switches the key with it.
    expect(resolveDeploymentModel({ ...both, PI_DEFAULT_PROVIDER: "anthropic" })).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5",
      key: "sk-ant-key",
    });
    // A provider with no key configured yields no key — never another vendor's.
    expect(
      resolveDeploymentModel({ OPENROUTER_API_KEY: "or-key", PI_DEFAULT_PROVIDER: "anthropic" }),
    ).toEqual({ provider: "anthropic", model: "claude-sonnet-5", key: undefined });
  });

  it("uses the operator's own OpenAI-compatible server when asked", () => {
    const local = {
      PI_DEFAULT_PROVIDER: "local",
      NOVA_LOCAL_MODELS: "gpt-4o, claude-sonnet",
      NOVA_LOCAL_MODELS_API_KEY: "sk-litellm",
    };
    expect(resolveDeploymentModel(local)).toEqual({
      provider: "local",
      model: "gpt-4o",
      key: "sk-litellm",
    });
    // A keyless server still counts as configured, so nobody is asked to connect a model.
    const { NOVA_LOCAL_MODELS_API_KEY: _key, ...keyless } = local;
    expect(resolveDeploymentModel(keyless).key).toBe("local");
    // No model list means no local deployment model.
    expect(resolveDeploymentModel({ PI_DEFAULT_PROVIDER: "local" }).key).toBeUndefined();
  });
});
