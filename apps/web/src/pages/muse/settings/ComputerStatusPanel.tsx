import { useLingui } from "@lingui/react/macro";
import type { ComputerStatus } from "@superchat/contracts";
import { useEffect, useState } from "react";
import { rpc } from "../../../lib/rpc";
import { SettingsGroup, SettingsRow } from "./kit";

type Host = { hostId: string | null; agentName: string | null; harness: string | null };
type SessionModel = { harness: string; model: string | null; defaultModel: string | null };

/** The calls the panel makes; the live RPC unless a test supplies its own. */
export type ComputerStatusWire = {
  status: (input: { botId: string }) => Promise<ComputerStatus>;
  host: (input: { botId: string }) => Promise<Host>;
  sessionModel: (input: { botId: string }) => Promise<{
    harness: string;
    model: string | null;
    catalog: { defaultModel?: string | null; models: { id: string; label: string }[] };
  }>;
};

/**
 * Made once: the RPC client hands out a new `rpc.computer` object on every read, so using it
 * as a default would change the effect's deps each render and reload forever.
 */
const LIVE_WIRE: ComputerStatusWire = {
  status: (input) => rpc.computer.status(input),
  host: (input) => rpc.computer.host(input),
  sessionModel: (input) => rpc.engineModels.sessionModel(input),
};

const POLL_MS = 10_000;

const HARNESS_LABEL: Record<string, string> = { "claude-sdk": "Claude Agent SDK", pi: "Pi" };

/** Settings > Computer: where the Conversation runs (the host) and the harness on it. Read-only. */
export function ComputerStatusPanel({
  botId,
  sandboxProvider,
  wire = LIVE_WIRE,
}: {
  botId: string;
  sandboxProvider?: string | null;
  wire?: ComputerStatusWire;
}) {
  const { t } = useLingui();
  const [status, setStatus] = useState<ComputerStatus | null>(null);
  const [host, setHost] = useState<Host | null>(null);
  const [model, setModel] = useState<SessionModel | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [s, h, m] = await Promise.allSettled([
        wire.status({ botId }),
        wire.host({ botId }),
        wire.sessionModel({ botId }),
      ]);
      if (cancelled) return;
      if (s.status === "fulfilled") setStatus(s.value);
      if (h.status === "fulfilled") setHost(h.value);
      if (m.status === "fulfilled") {
        const { catalog } = m.value;
        const id = catalog.defaultModel ?? "";
        setModel({
          harness: m.value.harness,
          model: m.value.model,
          defaultModel: catalog.models.find((x) => x.id === id)?.label ?? null,
        });
      }
      setFailed(s.status === "rejected" && h.status === "rejected");
    }
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [botId, wire]);

  const stateLabel = (() => {
    if (!status) return failed ? t`Unavailable` : t`Loading…`;
    if (status.launch) return status.launch.stage === "failed" ? t`Failed to start` : t`Starting`;
    if (status.state === "running") return status.runnerReady === false ? t`Starting` : t`Running`;
    if (status.state === "booting") return t`Starting`;
    if (status.state === "error") return t`Needs attention`;
    return host?.hostId || host?.agentName ? t`Sleeping` : t`Not started`;
  })();

  const harnessId = host?.harness ?? model?.harness ?? null;
  const harnessLabel = harnessId ? (HARNESS_LABEL[harnessId] ?? harnessId) : null;
  const modelLabel = model
    ? model.model || (model.defaultModel ? t`Default · ${model.defaultModel}` : t`Default`)
    : null;
  const provider = sandboxProvider || status?.kind || null;

  return (
    <div className="space-y-5" data-testid="computer-status-settings">
      <SettingsGroup
        title={t`Computer`}
        footer={t`The machine your Conversation runs on. It starts when it is needed.`}
      >
        <SettingsRow label={t`Status`} value={stateLabel} />
        {host?.hostId ? <SettingsRow label={t`Host`} value={host.hostId} /> : null}
        {provider ? <SettingsRow label={t`Provider`} value={provider} /> : null}
      </SettingsGroup>
      <SettingsGroup title={t`Harness`}>
        <SettingsRow label={t`Harness`} value={harnessLabel ?? "-"} />
        {host?.agentName ? <SettingsRow label={t`Agent`} value={host.agentName} /> : null}
        <SettingsRow label={t`Model`} value={modelLabel ?? "-"} />
      </SettingsGroup>
    </div>
  );
}
