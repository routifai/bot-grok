import {
  BOT_NAME_MAX_LENGTH,
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_MODEL_MAX_TOKENS,
  DEFAULT_MUSE_COLOR,
  DEFAULT_MUSE_NAME,
  type IntegrationSetupState,
  MAX_MODEL_CONTEXT_WINDOW,
  MAX_MODEL_MAX_TOKENS,
  museBotProfile,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  openAiCompatibleConnectReady,
  openAiCompatibleProbeSuccessMessage,
  parseModelContextWindow,
  parseModelMaxImagesPerPrompt,
  parseModelMaxTokens,
  type ThinkingLevel,
} from "@aiden/contracts";
import { createModelProbe, GROK_BOT_COLORS, initialModelProbeState } from "@aiden/core";
import {
  BotAvatar,
  Button,
  cn,
  Input,
  ModelThinkingOptions,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@aiden/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { IntegrationSetup } from "../components/integrations/IntegrationSetup";
import { authClient } from "../lib/auth";
import type { ModelCatalogEntry } from "../lib/model-auth";
import { rpc } from "../lib/rpc";
import { useModelOAuthSignIn } from "../lib/use-model-oauth-signin";
import { AuroraBackground } from "./muse/intro/AuroraBackground";

const CUSTOM_MODEL_OPTION = "__aiden_custom_model__";
const FIRST_BOT_NAME = "Chief";
const FIRST_BOT_SPAWN_KEY = "onboarding:first";
const FIRST_BOT_LOCK = "aiden:onboarding-first-bot";
/** A small set of colors for the Muse's identity, sky first (the default). */
const MUSE_COLOR_OPTIONS = [...new Set([DEFAULT_MUSE_COLOR, ...GROK_BOT_COLORS])].slice(0, 6);

/** The Muse identity/model steps that show progress dots; "intro" and "bot" don't. */
const MUSE_ONBOARDING_STEPS = ["name", "museName", "color", "model"] as const;

/** Progress dots for the Muse onboarding steps (docs/muse/DESIGN.md "Onboarding"). */
function StepDots({ step }: { step: (typeof MUSE_ONBOARDING_STEPS)[number] }) {
  const index = MUSE_ONBOARDING_STEPS.indexOf(step);
  return (
    <div className="mt-8 flex justify-center gap-1.5" aria-hidden="true">
      {MUSE_ONBOARDING_STEPS.map((candidate, i) => (
        <span
          key={candidate}
          className={cn(
            "h-1.5 w-1.5 rounded-full transition-colors",
            i <= index ? "bg-foreground" : "bg-border",
          )}
        />
      ))}
    </div>
  );
}

/** Survives StrictMode remounts; concurrent first-bot creates share one in-flight attempt. */
let firstBotEnsure: Promise<{ id: string }> | null = null;

function findFirstBot(
  bots: Array<{ id: string; name: string; spawnKey: string | null }>,
): { id: string } | undefined {
  const bySpawnKey = bots.find((bot) => bot.spawnKey === FIRST_BOT_SPAWN_KEY);
  if (bySpawnKey) return { id: bySpawnKey.id };
  // Legacy first-run Chief created before spawnKey was set.
  const byName = bots.find((bot) => bot.name === FIRST_BOT_NAME);
  return byName ? { id: byName.id } : undefined;
}

/** The Muse's chosen name and identity color. */
type FirstBotProfile = {
  name: string;
  color?: string;
  title?: string;
  description?: string;
  instructions?: string;
};

async function createOrReuseFirstBot(profile: FirstBotProfile): Promise<{ id: string }> {
  const existing = await rpc.bots.list();
  const reuse = findFirstBot(existing);
  if (reuse) return reuse;
  try {
    const created = await rpc.bots.create({
      name: profile.name,
      title: profile.title ?? "",
      description: profile.description ?? "",
      instructions: profile.instructions ?? "",
      notifyOnFinish: true,
      spawnKey: FIRST_BOT_SPAWN_KEY,
      ...(profile.color ? { color: profile.color } : {}),
    });
    return { id: created.id };
  } catch (error) {
    // Another tab won the unique (spaceId, spawnKey) race; reuse that bot only.
    const afterConflict = await rpc.bots.list();
    const winner = afterConflict.find((bot) => bot.spawnKey === FIRST_BOT_SPAWN_KEY);
    if (winner) return { id: winner.id };
    throw error;
  }
}

async function withFirstBotLock<T>(run: () => Promise<T>): Promise<T> {
  const locks = globalThis.navigator?.locks;
  if (!locks?.request) return run();
  return locks.request(FIRST_BOT_LOCK, run);
}

async function ensureFirstBot(profile: FirstBotProfile): Promise<{ id: string }> {
  if (firstBotEnsure) return firstBotEnsure;
  // Web Lock serializes cross-tab creates; module promise covers same-tab StrictMode.
  // spawnKey makes create idempotent when locks are unavailable.
  // Clear after settle so a later empty-space visit re-lists instead of reusing a deleted id.
  firstBotEnsure = withFirstBotLock(() => createOrReuseFirstBot(profile)).finally(() => {
    firstBotEnsure = null;
  });
  return firstBotEnsure;
}

function providerLabel(entry: ModelCatalogEntry): string {
  return entry.provider === "openai-codex" ? "ChatGPT" : (entry.providerName ?? entry.provider);
}

function nextStepAfterModel(needsIntegrationSetup: boolean): "integrations" | "bot" {
  return needsIntegrationSetup ? "integrations" : "bot";
}

export function OnboardingPage() {
  const { t } = useLingui();
  const navigate = useNavigate();
  const fieldId = useId();
  const [step, setStep] = useState<
    "loading" | "intro" | "name" | "museName" | "color" | "model" | "integrations" | "bot"
  >("loading");
  /** What to show once the name → Muse name → color steps are done. */
  const [postIdentityStep, setPostIdentityStep] = useState<"model" | "integrations" | "bot">(
    "model",
  );
  const [personName, setPersonName] = useState("");
  const [museName, setMuseName] = useState(DEFAULT_MUSE_NAME);
  const [museColor, setMuseColor] = useState(DEFAULT_MUSE_COLOR);
  const [integrationSetup, setIntegrationSetup] = useState<IntegrationSetupState | null>(null);
  const needsIntegrationSetup = integrationSetup?.needsSetup ?? false;
  const [integrationServers, setIntegrationServers] = useState<string[]>([]);
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([]);
  const [provider, setProvider] = useState("openrouter");
  const [modelId, setModelId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [reasoning, setReasoning] = useState(false);
  const [manualModelId, setManualModelId] = useState(false);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel | null>(null);
  const [maxTokens, setMaxTokens] = useState(String(DEFAULT_MODEL_MAX_TOKENS));
  const [contextWindow, setContextWindow] = useState(String(DEFAULT_MODEL_CONTEXT_WINDOW));
  const [supportsImages, setSupportsImages] = useState(false);
  const [maxImagesPerPrompt, setMaxImagesPerPrompt] = useState("");
  const [{ models: probeModels, probing }, setProbe] = useState(initialModelProbeState);
  const [modelProbe] = useState(() => createModelProbe(setProbe));
  const resetOpenAiCompatibleProbe = modelProbe.reset;
  const createStartedRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const {
    oauth,
    pasteCode,
    setPasteCode,
    oauthPending,
    cancelOAuthAttempt,
    startSubscriptionSignIn,
    submitOAuthCode,
  } = useModelOAuthSignIn({
    onClearError: () => setError(null),
    onError: setError,
    onFinished: () => {
      setStep(nextStepAfterModel(needsIntegrationSetup));
    },
  });

  useEffect(() => {
    void Promise.all([
      rpc.me(),
      rpc.models.list().catch(() => []),
      rpc.integrationSetup.get().catch(() => null),
    ])
      .then(([me, models, integrations]) => {
        setIntegrationSetup(integrations);
        setCatalog(models);
        const preferred =
          models.find(
            (entry) => entry.provider === me.defaultProvider && entry.id === me.defaultModel,
          ) ??
          models.find((entry) => entry.provider === me.defaultProvider) ??
          models[0];
        if (preferred) {
          setProvider(preferred.provider);
          setModelId(preferred.provider === OPENAI_COMPATIBLE_PROVIDER_ID ? "" : preferred.id);
        }
        const entryStep = me.needsModel
          ? "model"
          : integrations?.needsSetup
            ? "integrations"
            : "bot";
        setPersonName(me.name ?? "");
        setPostIdentityStep(entryStep);
        setStep("intro");
      })
      .catch(() => setStep("bot"));
    return () => {
      modelProbe.invalidate();
    };
  }, []);

  const providers = useMemo(() => {
    const seen = new Map<string, ModelCatalogEntry>();
    for (const entry of catalog) {
      if (!seen.has(entry.provider)) seen.set(entry.provider, entry);
    }
    return [...seen.values()];
  }, [catalog]);

  const modelsForProvider = useMemo(
    () => catalog.filter((entry) => entry.provider === provider),
    [catalog, provider],
  );

  const selected = modelsForProvider.find((entry) => entry.id === modelId) ?? modelsForProvider[0];
  const isOpenAiCompatible = provider === OPENAI_COMPATIBLE_PROVIDER_ID;
  const subscriptionSignIn = selected?.signIn !== undefined;
  const acceptsKey = selected?.auth !== "oauth";
  const signInLabel = selected?.oauthLabel ?? t`Sign in`;
  const openAiCompatibleReady = openAiCompatibleConnectReady({
    baseUrl,
    modelId,
  });
  const canSaveModel = Boolean(
    selected &&
      modelId.trim() &&
      !oauthPending &&
      (isOpenAiCompatible ? openAiCompatibleReady : acceptsKey && apiKey.trim()),
  );
  const otherModelLabel = t`Other model…`;
  // Base UI Select.Value only resolves labels when Root gets `items`.
  const providerItems = useMemo(
    () => providers.map((entry) => ({ value: entry.provider, label: providerLabel(entry) })),
    [providers],
  );
  const modelItems = useMemo(
    () => modelsForProvider.map((entry) => ({ value: entry.id, label: entry.label })),
    [modelsForProvider],
  );
  const probeModelItems = useMemo(
    () => [
      ...probeModels.map((id) => ({ value: id, label: id })),
      { value: CUSTOM_MODEL_OPTION, label: otherModelLabel },
    ],
    [otherModelLabel, probeModels],
  );

  function updateBaseUrl(nextBaseUrl: string) {
    setBaseUrl(nextBaseUrl);
    // Keep Other model… mode across URL edits; only provider change clears it.
    resetOpenAiCompatibleProbe();
    setError(null);
    setNotice(null);
  }

  function updateApiKey(nextApiKey: string) {
    setApiKey(nextApiKey);
    resetOpenAiCompatibleProbe();
  }

  function selectProvider(nextProvider: string) {
    if (nextProvider === provider) return;
    cancelOAuthAttempt();
    setProvider(nextProvider);
    setApiKey("");
    setModelId(
      nextProvider === OPENAI_COMPATIBLE_PROVIDER_ID
        ? ""
        : (catalog.find((item) => item.provider === nextProvider)?.id ?? ""),
    );
    setBaseUrl("");
    setReasoning(false);
    setThinkingLevel(null);
    setManualModelId(false);
    setSupportsImages(false);
    setMaxTokens(String(DEFAULT_MODEL_MAX_TOKENS));
    setContextWindow(String(DEFAULT_MODEL_CONTEXT_WINDOW));
    setMaxImagesPerPrompt("");
    resetOpenAiCompatibleProbe();
    setError(null);
    setNotice(null);
  }

  async function probeServerModels() {
    if (!baseUrl.trim()) return;
    setError(null);
    setNotice(null);
    await modelProbe.probe({
      baseUrl,
      apiKey,
      request: rpc.models.probeOpenAiCompatible,
      onSuccess: (models) => {
        setModelId((current) => {
          const trimmed = current.trim();
          const next = trimmed || models[0] || "";
          // Stay in manual entry across re-probes so a typed id that matches a
          // discovered model cannot yank the freeform field back to the Select.
          setManualModelId(
            (wasManual) => wasManual || (Boolean(trimmed) && !models.includes(trimmed)),
          );
          return next;
        });
        setNotice(openAiCompatibleProbeSuccessMessage(models.length));
      },
      onError: (err) =>
        setError(err instanceof Error ? err.message : t`Could not reach this model server`),
    });
  }

  async function saveModel() {
    if (!canSaveModel) return;
    setError(null);
    try {
      if (isOpenAiCompatible) {
        const parsedMaxImagesPerPrompt = parseModelMaxImagesPerPrompt(
          maxImagesPerPrompt,
          supportsImages,
        );
        if (supportsImages && maxImagesPerPrompt.trim() && parsedMaxImagesPerPrompt === undefined) {
          setError(t`Enter a whole number from 1 to 1000 for the image limit.`);
          return;
        }
        const maxImagesPerPromptInput =
          supportsImages && !maxImagesPerPrompt.trim() ? null : parsedMaxImagesPerPrompt;

        const parsedMaxTokens = parseModelMaxTokens(maxTokens);
        if (parsedMaxTokens === undefined) {
          setError(
            t`Enter a whole number from 1 to ${MAX_MODEL_MAX_TOKENS} for maximum output tokens.`,
          );
          return;
        }
        const parsedContextWindow = parseModelContextWindow(contextWindow);
        if (parsedContextWindow === undefined) {
          setError(
            t`Enter a whole number from 1 to ${MAX_MODEL_CONTEXT_WINDOW} for the context limit.`,
          );
          return;
        }
        await rpc.models.connect({
          provider,
          baseUrl: baseUrl.trim(),
          modelId: modelId.trim(),
          reasoning,
          thinkingLevel: reasoning ? thinkingLevel : null,
          maxTokens: parsedMaxTokens,
          contextWindow: parsedContextWindow,
          supportsImages,
          maxImagesPerPrompt: maxImagesPerPromptInput,
          apiKey: apiKey.trim() || undefined,
          label: selected?.providerName ?? provider,
        });
      } else if (apiKey) {
        await rpc.models.connect({
          provider,
          apiKey,
          modelId,
          label: selected?.providerName ?? provider,
        });
      }
      setStep(nextStepAfterModel(needsIntegrationSetup));
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not save model`);
    }
  }

  function beginSelectedSubscriptionSignIn() {
    if (!selected?.id) return;
    void startSubscriptionSignIn({
      provider: selected.provider,
      modelId: selected.id,
      label: selected.providerName ?? selected.provider,
    });
  }

  async function saveName() {
    const trimmed = personName.trim();
    if (!trimmed) return;
    setError(null);
    const result = await authClient.updateUser({ name: trimmed });
    if (result.error) {
      setError(result.error.message ?? t`Could not save your name`);
      return;
    }
    setStep("museName");
  }

  function saveMuseName() {
    if (!museName.trim()) return;
    setError(null);
    setStep("color");
  }

  function saveMuseColor() {
    setStep(postIdentityStep);
  }

  async function createFirstBot() {
    if (createStartedRef.current) return;
    createStartedRef.current = true;
    setError(null);
    try {
      const bot = await ensureFirstBot({
        name: museName.trim() || DEFAULT_MUSE_NAME,
        color: museColor,
        ...museBotProfile(museName.trim() || DEFAULT_MUSE_NAME, personName),
      });
      for (const serverId of integrationServers) {
        await rpc.mcp.assignments.approve({ botId: bot.id, serverId });
      }
      // Onboarding continues conversationally in the thread: greeting first,
      // then the focus choice (immediate for the first bot).
      const started = await rpc.onboarding
        .start({ botId: bot.id })
        .then(() => true)
        .catch(() => false);
      if (started) {
        await rpc.onboarding.promptFocus({ botId: bot.id }).catch(() => undefined);
      }
      navigate(`/app/${bot.id}`);
    } catch (err) {
      createStartedRef.current = false;
      setError(err instanceof Error ? err.message : t`Could not create your bot`);
    }
  }

  useEffect(() => {
    if (step !== "bot") return;
    void createFirstBot();
  }, [step]);

  return (
    <div className="relative isolate flex min-h-screen items-center justify-center px-6 py-16">
      <AuroraBackground />
      <div className="mx-auto w-full max-w-[440px]">
        {step === "loading" ? (
          <p className="text-muted-foreground">
            <Trans>Loading…</Trans>
          </p>
        ) : null}
        {step === "intro" ? (
          <div className="flex flex-col items-center text-center">
            <BotAvatar color={DEFAULT_MUSE_COLOR} identity="muse-intro" face="muse" size={120} />
            <h1 className="mt-7 font-display text-[40px] leading-[1.05] tracking-[-0.01em] text-foreground">
              <Trans>
                Hi, I'm Nova — <em className="italic">already on it.</em>
              </Trans>
            </h1>
            <p className="mt-3 text-[15px] text-muted-foreground">
              <Trans>
                I'll plan, research, draft and follow up in the background, and always ask before
                anything I can't undo.
              </Trans>
            </p>
            <Button className="mt-8 h-12 w-full text-[15px]" onClick={() => setStep("name")}>
              <Trans>Let's get started</Trans>
            </Button>
          </div>
        ) : null}
        {step === "name" ? (
          <div>
            <h1 className="font-display text-[40px] leading-[1.05] tracking-[-0.01em] text-foreground">
              <Trans>First, what should I call you?</Trans>
            </h1>
            <Input
              className="mt-8 h-14 rounded-xl text-[16px]"
              value={personName}
              onChange={(e) => setPersonName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveName();
              }}
              aria-label={t`Your name`}
              placeholder={t`Your name`}
              autoFocus
              maxLength={120}
            />
            {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
            <div className="mt-6">
              <Button
                className="h-12 w-full text-[15px]"
                disabled={!personName.trim()}
                onClick={() => void saveName()}
              >
                <Trans>Continue</Trans>
              </Button>
            </div>
            <StepDots step="name" />
          </div>
        ) : null}
        {step === "museName" ? (
          <div>
            <h1 className="font-display text-[40px] leading-[1.05] tracking-[-0.01em] text-foreground">
              <Trans>And what would you like to call me?</Trans>
            </h1>
            <Input
              className="mt-8 h-14 rounded-xl text-[16px]"
              value={museName}
              onChange={(e) => setMuseName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveMuseName();
              }}
              aria-label={t`Muse name`}
              placeholder={DEFAULT_MUSE_NAME}
              autoFocus
              maxLength={BOT_NAME_MAX_LENGTH}
            />
            {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
            <div className="mt-6">
              <Button
                className="h-12 w-full text-[15px]"
                disabled={!museName.trim()}
                onClick={saveMuseName}
              >
                <Trans>Continue</Trans>
              </Button>
            </div>
            <StepDots step="museName" />
          </div>
        ) : null}
        {step === "color" ? (
          <div>
            <h1 className="text-center font-display text-[40px] leading-[1.05] tracking-[-0.01em] text-foreground">
              <Trans>Pick my color.</Trans>
            </h1>
            <div className="mt-8 flex justify-center">
              <BotAvatar color={museColor} identity={museName} face="muse" size={120} />
            </div>
            <div className="mt-8 grid grid-cols-6 place-items-center gap-2">
              {MUSE_COLOR_OPTIONS.map((color) => {
                const selected = museColor.toLowerCase() === color.toLowerCase();
                return (
                  <button
                    key={color}
                    type="button"
                    onClick={() => setMuseColor(color)}
                    aria-label={t`Color ${color}`}
                    aria-pressed={selected}
                    className={`size-8 rounded-full border transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring ${
                      selected
                        ? "scale-105 border-transparent ring-2 ring-foreground ring-offset-2 ring-offset-background"
                        : "border-border"
                    }`}
                    style={{ backgroundColor: color }}
                  />
                );
              })}
            </div>
            <div className="mt-6">
              <Button className="h-12 w-full text-[15px]" onClick={saveMuseColor}>
                <Trans>Continue</Trans>
              </Button>
            </div>
            <StepDots step="color" />
          </div>
        ) : null}
        {step === "model" ? (
          <div>
            <h1 className="text-[32px] font-medium text-foreground">
              <Trans>Last thing — connect the brain I'll think with.</Trans>
            </h1>
            <StepDots step="model" />
            <div className="mt-8 block text-sm font-medium text-foreground">
              <span>
                <Trans>Provider</Trans>
              </span>
              <Select
                value={provider}
                onValueChange={(value) => {
                  if (typeof value !== "string" || !value) return;
                  selectProvider(value);
                }}
                items={providerItems}
              >
                <SelectTrigger aria-label={t`Provider`} className="mt-2 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {providers.map((entry) => (
                    <SelectItem key={entry.provider} value={entry.provider}>
                      {providerLabel(entry)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="mt-6 block text-sm text-foreground">
              {isOpenAiCompatible ? (
                <>
                  <label htmlFor={`${fieldId}-base-url`} className="block font-medium">
                    <Trans>Server URL</Trans>
                    <Input
                      id={`${fieldId}-base-url`}
                      value={baseUrl}
                      onChange={(e) => updateBaseUrl(e.target.value)}
                      aria-label={t`OpenAI-compatible server URL`}
                      placeholder="http://127.0.0.1:8000/v1"
                      autoComplete="off"
                      className="mt-2"
                    />
                  </label>
                  <div className="mt-3">
                    <Button
                      variant="outline"
                      disabled={probing || !baseUrl.trim()}
                      onClick={() => void probeServerModels()}
                    >
                      {probing ? <Trans>Finding…</Trans> : <Trans>Find models</Trans>}
                    </Button>
                  </div>
                  <div className="mt-4 block">
                    <span className="font-medium">
                      <Trans>Model</Trans>
                    </span>
                    {probeModels.length && !manualModelId ? (
                      <Select
                        value={modelId}
                        onValueChange={(value) => {
                          if (typeof value !== "string") return;
                          const next = value;
                          if (next === CUSTOM_MODEL_OPTION) {
                            setManualModelId(true);
                            setModelId("");
                          } else {
                            setManualModelId(false);
                            setModelId(next);
                          }
                        }}
                        items={probeModelItems}
                      >
                        <SelectTrigger aria-label={t`Models from server`} className="mt-2 w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {probeModels.map((id) => (
                            <SelectItem key={id} value={id}>
                              {id}
                            </SelectItem>
                          ))}
                          <SelectItem value={CUSTOM_MODEL_OPTION}>
                            <Trans>Other model…</Trans>
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        value={modelId}
                        onChange={(e) => {
                          setManualModelId(true);
                          setModelId(e.target.value);
                        }}
                        aria-label={t`Model id`}
                        placeholder="exact-model-id"
                        className="mt-2"
                      />
                    )}
                    {probeModels.length && manualModelId ? (
                      <Button
                        variant="link"
                        size="xs"
                        className="mt-2 px-0 text-muted-foreground"
                        onClick={() => {
                          setManualModelId(false);
                          setModelId(probeModels[0] ?? "");
                        }}
                      >
                        <Trans>Use a found model</Trans>
                      </Button>
                    ) : null}
                  </div>
                  <ModelThinkingOptions
                    reasoning={reasoning}
                    onReasoningChange={(value) => {
                      setReasoning(value);
                      if (!value) setThinkingLevel(null);
                    }}
                    advancedLabel={t`Advanced`}
                    thinkingLabel={t`Supports thinking`}
                    thinkingLevel={thinkingLevel}
                    onThinkingLevelChange={(value) =>
                      setThinkingLevel(value as ThinkingLevel | null)
                    }
                    thinkingLevelOptions={[
                      { value: "minimal", label: t`Minimal` },
                      { value: "low", label: t`Low` },
                      { value: "medium", label: t`Medium` },
                      { value: "high", label: t`High` },
                      { value: "xhigh", label: t`Extra high` },
                      { value: "max", label: t`Max` },
                    ]}
                    thinkingLevelLabel={t`Reasoning effort`}
                    thinkingLevelDefaultLabel={t`Default`}
                    maxTokens={maxTokens}
                    onMaxTokensChange={setMaxTokens}
                    maxTokensLabel={t`Maximum output tokens`}
                    contextWindow={contextWindow}
                    onContextWindowChange={setContextWindow}
                    contextWindowLabel={t`Context limit`}
                    supportsImages={supportsImages}
                    onSupportsImagesChange={setSupportsImages}
                    imagesLabel={t`Supports images`}
                    maxImagesPerPrompt={maxImagesPerPrompt}
                    onMaxImagesPerPromptChange={setMaxImagesPerPrompt}
                    maxImagesLabel={t`Maximum images per request`}
                  />
                </>
              ) : (
                <>
                  <span className="font-medium">
                    <Trans>Model</Trans>
                  </span>
                  <Select
                    value={selected?.id ?? modelId}
                    onValueChange={(value) => {
                      if (typeof value !== "string" || !value) return;
                      if (value === modelId) return;
                      cancelOAuthAttempt();
                      setModelId(value);
                    }}
                    items={modelItems}
                  >
                    <SelectTrigger aria-label={t`Model`} className="mt-2 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {modelsForProvider.map((entry) => (
                        <SelectItem key={`${entry.provider}:${entry.id}`} value={entry.id}>
                          {entry.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </>
              )}
            </div>
            {subscriptionSignIn ? (
              <div className="mt-4">
                {oauth ? (
                  <div className="rounded-lg border border-border px-3.5 py-3">
                    {oauth.mode === "auth-url" ? (
                      <>
                        <p className="text-sm text-muted-foreground">
                          <Trans>
                            Finish signing in at{" "}
                            <a
                              href={oauth.verificationUri}
                              target="_blank"
                              rel="noreferrer"
                              className="text-foreground underline"
                            >
                              {new URL(oauth.verificationUri).hostname}
                            </a>
                            . The final page may not load; paste its URL or code here.
                          </Trans>
                        </p>
                        <div className="mt-3 flex items-center gap-2">
                          <Input
                            value={pasteCode}
                            onChange={(e) => setPasteCode(e.target.value)}
                            aria-label={t`Authorization code or callback URL`}
                            autoComplete="off"
                            spellCheck={false}
                            placeholder="http://localhost:53692/callback?code=…"
                          />
                          <Button
                            disabled={!pasteCode.trim()}
                            onClick={() => void submitOAuthCode()}
                          >
                            <Trans>Submit</Trans>
                          </Button>
                        </div>
                        <p className="mt-2 text-sm text-muted-foreground">
                          <Trans>Waiting for sign-in…</Trans>
                        </p>
                      </>
                    ) : (
                      <>
                        <p className="text-sm text-muted-foreground">
                          <Trans>
                            Enter this code at{" "}
                            <a
                              href={oauth.verificationUri}
                              target="_blank"
                              rel="noreferrer"
                              className="text-foreground underline"
                            >
                              {oauth.verificationUri.replace(/^https:\/\//, "")}
                            </a>
                          </Trans>
                        </p>
                        <p className="mt-2 font-mono text-[22px] tracking-[0.2em] text-foreground">
                          {oauth.userCode}
                        </p>
                        <p className="mt-2 text-sm text-muted-foreground">
                          <Trans>Waiting for sign-in…</Trans>
                        </p>
                      </>
                    )}
                  </div>
                ) : (
                  <Button disabled={oauthPending} onClick={() => beginSelectedSubscriptionSignIn()}>
                    {oauthPending ? <Trans>Starting…</Trans> : signInLabel}
                  </Button>
                )}
              </div>
            ) : null}
            {acceptsKey ? (
              isOpenAiCompatible ? (
                <details className="mt-4 text-sm text-muted-foreground">
                  <summary className="w-fit cursor-pointer select-none">
                    <Trans>API key</Trans>
                  </summary>
                  <Input
                    aria-label={t`API key`}
                    value={apiKey}
                    onChange={(e) => updateApiKey(e.target.value)}
                    placeholder={t`Optional`}
                    type="password"
                    autoComplete="new-password"
                    className="mt-2"
                  />
                </details>
              ) : (
                <label
                  htmlFor={`${fieldId}-api-key`}
                  className="mt-4 block text-sm font-medium text-foreground"
                >
                  {subscriptionSignIn ? <Trans>Or paste an API key</Trans> : <Trans>API key</Trans>}
                  <Input
                    id={`${fieldId}-api-key`}
                    value={apiKey}
                    onChange={(e) => updateApiKey(e.target.value)}
                    placeholder="sk-…"
                    type="password"
                    autoComplete="new-password"
                    className="mt-2"
                  />
                </label>
              )
            ) : null}
            {notice ? <p className="mt-3 text-sm text-success">{notice}</p> : null}
            {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
            <div className="mt-6 flex gap-3">
              <Button disabled={!canSaveModel} onClick={() => void saveModel()}>
                <Trans>Continue</Trans>
              </Button>
            </div>
          </div>
        ) : null}
        {step === "integrations" ? (
          <IntegrationSetup
            serverSetup
            initialState={integrationSetup}
            onDone={() => setStep("bot")}
            onServerConnected={(id) =>
              setIntegrationServers((current) => [...new Set([...current, id])])
            }
          />
        ) : null}
        {step === "bot" ? (
          <div>
            {error ? (
              <div>
                <p className="text-sm text-destructive">{error}</p>
                <Button className="mt-4" onClick={() => void createFirstBot()}>
                  <Trans>Try again</Trans>
                </Button>
              </div>
            ) : (
              <p className="text-muted-foreground">
                <Trans>Opening chat…</Trans>
              </p>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
