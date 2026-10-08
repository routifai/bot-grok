import { Trans, useLingui } from "@lingui/react/macro";
import type { VoiceCatalogEntry, VoiceCredential, VoiceInfo } from "@nova/contracts";
import { Button, Input, Skeleton } from "@nova/ui-web";
import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import { rpc } from "../../../lib/rpc";
import { SETTINGS_ROW, SettingsGroup, SettingsLinkRow } from "./kit";

/**
 * Settings > Voice: which service reads replies aloud and hears you. Pick a provider, paste
 * its key once, then choose a voice.
 */
export function VoicePanel({ onBusyChange }: { onBusyChange?: (busy: boolean) => void }) {
  const { t } = useLingui();
  const [catalog, setCatalog] = useState<VoiceCatalogEntry[] | null>(null);
  const [credentials, setCredentials] = useState<VoiceCredential[]>([]);
  const [provider, setProvider] = useState("");
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function refresh(nextProvider?: string) {
    const [nextCatalog, nextCredentials, status] = await Promise.all([
      rpc.voice.catalog(),
      rpc.voice.credentials(),
      rpc.voice.status(),
    ]);
    const selected = nextProvider || status.provider || nextCatalog[0]?.id || "";
    setCatalog(nextCatalog);
    setCredentials(nextCredentials);
    setProvider(selected);
    setVoices(
      nextCredentials.some((entry) => entry.provider === selected)
        ? await rpc.voice.voices({ provider: selected }).catch(() => [])
        : [],
    );
  }

  useEffect(() => {
    void refresh().catch(() => {
      setCatalog([]);
      setError(t`Could not load voice settings.`);
    });
  }, []);

  async function run(action: () => Promise<void>, failure: string) {
    setBusy(true);
    onBusyChange?.(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : failure);
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  }

  if (catalog === null) return <Skeleton className="h-[210px] w-full rounded-[22px]" />;

  const selected = catalog.find((entry) => entry.id === provider);
  const credential = credentials.find((entry) => entry.provider === provider);
  const voiceId = credential?.voiceId || voices[0]?.id || "";

  return (
    <div className="flex flex-col gap-7" data-testid="voice-settings">
      <SettingsGroup title={<Trans>Service</Trans>}>
        {catalog.map((entry) => {
          const connected = credentials.some((cred) => cred.provider === entry.id);
          const active = entry.id === provider;
          return (
            <button
              key={entry.id}
              type="button"
              disabled={busy}
              aria-pressed={active}
              onClick={() => {
                if (active) return;
                setApiKey("");
                void run(() => refresh(entry.id), t`Could not load this service.`);
              }}
              className={`${SETTINGS_ROW} text-start transition-colors hover:bg-accent/50`}
            >
              <span className="min-w-0">
                <span className="block text-[16px] text-foreground">{entry.name}</span>
                <span className="block text-[13px] text-muted-foreground">
                  {connected ? (
                    <Trans>Connected</Trans>
                  ) : entry.transcribe ? (
                    <Trans>Speaks and listens</Trans>
                  ) : (
                    <Trans>Speaks only</Trans>
                  )}
                </span>
              </span>
              {active ? (
                <Check size={18} strokeWidth={2.25} className="shrink-0 text-primary" />
              ) : null}
            </button>
          );
        })}
      </SettingsGroup>

      {selected && !credential ? (
        <SettingsGroup
          title={<Trans>Connect {selected.name}</Trans>}
          footer={<Trans>The key is stored encrypted and only used for voice.</Trans>}
        >
          <form
            className="flex items-center gap-2 px-3 py-2.5"
            onSubmit={(event) => {
              event.preventDefault();
              if (!apiKey.trim()) return;
              void run(async () => {
                await rpc.voice.connect({ provider: selected.id, apiKey: apiKey.trim() });
                setApiKey("");
                await refresh(selected.id);
                setNotice(t`Connected ${selected.name}.`);
              }, t`Could not connect this service.`);
            }}
          >
            <Input
              type="password"
              aria-label={t`API key`}
              placeholder={t`API key`}
              autoComplete="new-password"
              value={apiKey}
              disabled={busy}
              onChange={(event) => setApiKey(event.target.value)}
              className="h-10 flex-1 rounded-xl border-0 bg-muted/70 shadow-none"
            />
            <Button type="submit" className="rounded-full" disabled={busy || !apiKey.trim()}>
              <Trans>Connect</Trans>
            </Button>
          </form>
        </SettingsGroup>
      ) : null}

      {selected && credential ? (
        <SettingsGroup title={<Trans>Voice</Trans>}>
          {voices.length > 0 ? (
            <label className={SETTINGS_ROW}>
              <span className="text-[16px] text-foreground">
                <Trans>Voice</Trans>
              </span>
              <select
                value={voiceId}
                disabled={busy}
                aria-label={t`Voice`}
                onChange={(event) => {
                  const next = event.target.value;
                  void run(async () => {
                    await rpc.voice.setVoice({ voiceId: next, provider: selected.id });
                    await refresh(selected.id);
                  }, t`Could not save that voice.`);
                }}
                className="max-w-[60%] truncate rounded-lg bg-muted px-2.5 py-1.5 text-[15px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {voices.map((voice) => (
                  <option key={voice.id} value={voice.id}>
                    {voice.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <SettingsLinkRow
            label={<Trans>Hear a sample</Trans>}
            onClick={() =>
              void run(async () => {
                const { speaker } = await import("../../../lib/tts.js");
                await speaker.speak(t`Hi, this is how I'll sound when I read replies out loud.`);
                if (speaker.state.error) throw new Error(speaker.state.error);
              }, t`Could not play a sample.`)
            }
          />
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await rpc.voice.disconnect({ provider: credential.provider });
                await refresh(credential.provider);
              }, t`Could not disconnect.`)
            }
            className={`${SETTINGS_ROW} text-start text-[16px] text-destructive transition-colors hover:bg-accent/50`}
          >
            <Trans>Disconnect</Trans>
          </button>
        </SettingsGroup>
      ) : null}

      {error ? (
        <p role="alert" className="px-4 text-[13px] text-destructive">
          {error}
        </p>
      ) : notice ? (
        <p className="px-4 text-[13px] text-muted-foreground">{notice}</p>
      ) : null}
    </div>
  );
}
