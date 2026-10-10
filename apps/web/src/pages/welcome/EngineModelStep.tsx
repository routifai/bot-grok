import { Trans, useLingui } from "@lingui/react/macro";
import { Button, cn, Input } from "@superchat/ui-web";
import { useId, useState } from "react";
import { useModelProviders } from "../../features/models";
import { errorText } from "../../lib/error-text";
import { rpc } from "../../lib/rpc";
import { welcomeFieldClass, welcomeSubmitClass } from "./WelcomeFrame";

/**
 * Onboarding's model step when Superchat runs on the engine: a provider (the engine's list) and an API key. The engine
 * checks the key with the provider before keeping it, so a rejected key comes back here, under
 * the field. Nothing is stored in Superchat.
 */
export function EngineModelStep({ onDone }: { onDone: () => void }) {
  const { t } = useLingui();
  const keyId = useId();
  const providers = useModelProviders();
  const [picked, setPicked] = useState<string | null>(null);
  const provider = picked ?? providers?.[0]?.provider ?? null;
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!provider || !apiKey.trim() || busy) return;
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
        {(providers ?? []).map((candidate) => (
          <button
            key={candidate.provider}
            type="button"
            aria-pressed={provider === candidate.provider}
            data-testid={`engine-provider-${candidate.provider}`}
            onClick={() => {
              setPicked(candidate.provider);
              setError(null);
            }}
            className={cn(
              "h-12 rounded-xl border border-welcome-night-line/16 text-sm font-medium text-welcome-night-ink transition-colors focus-visible:outline-2 focus-visible:outline-ring",
              provider === candidate.provider
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
          disabled={!provider || !apiKey.trim() || busy}
          onClick={() => void save()}
        >
          {busy ? <Trans>Checking…</Trans> : <Trans>Continue</Trans>}
        </Button>
      </div>
    </div>
  );
}
