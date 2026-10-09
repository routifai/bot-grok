import { Trans, useLingui } from "@lingui/react/macro";
import { Button, cn, Input } from "@nova/ui-web";
import { useId, useState } from "react";
import { errorText } from "../../lib/error-text";
import { rpc } from "../../lib/rpc";
import { welcomeFieldClass, welcomeSubmitClass } from "./WelcomeFrame";

const PROVIDERS = [
  { id: "anthropic", label: "Anthropic" },
  { id: "openrouter", label: "OpenRouter" },
] as const;

/**
 * Onboarding's model step when Nova runs on the engine: a provider and an API key. The engine
 * checks the key with the provider before keeping it, so a rejected key comes back here, under
 * the field. Nothing is stored in Nova.
 */
export function EngineModelStep({ onDone }: { onDone: () => void }) {
  const { t } = useLingui();
  const keyId = useId();
  const [provider, setProvider] = useState<(typeof PROVIDERS)[number]["id"]>("anthropic");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!apiKey.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await rpc.engineModels.connect({ provider, apiKey: apiKey.trim() });
      onDone();
    } catch (err) {
      setError(errorText(err, t`Could not save this key.`));
      setBusy(false);
    }
  }

  return (
    <div data-testid="engine-model-step">
      <fieldset aria-label={t`Provider`} className="m-0 mt-8 grid grid-cols-2 gap-2 border-0 p-0">
        {PROVIDERS.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            aria-pressed={provider === candidate.id}
            data-testid={`engine-provider-${candidate.id}`}
            onClick={() => {
              setProvider(candidate.id);
              setError(null);
            }}
            className={cn(
              "h-12 rounded-xl border border-welcome-night-line/16 text-sm font-medium text-welcome-night-ink transition-colors focus-visible:outline-2 focus-visible:outline-ring",
              provider === candidate.id
                ? "bg-welcome-night-bubble ring-2 ring-welcome-night-ink/60"
                : "bg-transparent hover:bg-welcome-night-bubble/60",
            )}
          >
            {candidate.label}
          </button>
        ))}
      </fieldset>
      <label htmlFor={keyId} className="mt-4 block text-sm font-medium text-welcome-night-ink">
        <Trans>API key</Trans>
        <Input
          id={keyId}
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void save();
          }}
          placeholder="sk-…"
          autoComplete="new-password"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          className={welcomeFieldClass}
        />
      </label>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="mt-6 flex w-full gap-3">
        <Button
          className={`${welcomeSubmitClass} mt-0`}
          disabled={!apiKey.trim() || busy}
          onClick={() => void save()}
        >
          {busy ? <Trans>Checking…</Trans> : <Trans>Continue</Trans>}
        </Button>
      </div>
    </div>
  );
}
