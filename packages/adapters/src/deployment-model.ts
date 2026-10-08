export const DEFAULT_OPENROUTER_MODEL_ID = "openai/gpt-5.6-luna";

/**
 * The deployment-wide model default: which provider a run falls back to when no user
 * credential applies, and the key for that provider.
 *
 * Vendor env names and model ids live here, in the adapter layer, not in core.
 */
export function resolveDeploymentModel(env: NodeJS.ProcessEnv = process.env) {
  const provider = env.PI_DEFAULT_PROVIDER?.trim() || "openrouter";
  // A row per provider that ships a deployment key. A third one adds a row here, not a
  // branch at each call site — and an unknown provider gets no key rather than another
  // vendor's, which a ternary on one provider would not give.
  // `local` is the operator's own OpenAI-compatible server (LiteLLM, vLLM, Ollama): its key
  // is optional, so a configured model list alone counts as a deployment model.
  const localModels = (env.NOVA_LOCAL_MODELS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const keys: Record<string, string | undefined> = {
    openrouter: env.OPENROUTER_API_KEY,
    anthropic: env.ANTHROPIC_API_KEY,
    local: env.NOVA_LOCAL_MODELS_API_KEY?.trim() || (localModels.length > 0 ? "local" : undefined),
  };
  const models: Record<string, string> = {
    openrouter: DEFAULT_OPENROUTER_MODEL_ID,
    anthropic: "claude-sonnet-5",
    ...(localModels[0] ? { local: localModels[0] } : {}),
  };
  return {
    provider,
    model: env.PI_DEFAULT_MODEL?.trim() || models[provider] || models.openrouter!,
    key: keys[provider],
  };
}
