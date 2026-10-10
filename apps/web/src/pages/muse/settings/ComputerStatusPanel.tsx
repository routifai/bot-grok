import { useLingui } from "@lingui/react/macro";
import type { ComputerRunner, ComputerRuntime, ComputerStatus } from "@superchat/contracts";
import { Button, cn, Input } from "@superchat/ui-web";
import { Check } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { rpc } from "../../../lib/rpc";
import { SETTINGS_ROW, SettingsGroup, SettingsRow, SettingsSegmented } from "./kit";

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
  runtime: (input: { botId: string }) => Promise<ComputerRuntime>;
  setAgent: (input: { botId: string; agent: string }) => Promise<{ agent: string }>;
  moveRunner: (input: {
    botId: string;
    hostId: string;
    workspace?: string;
  }) => Promise<{ hostId: string }>;
};

/**
 * Made once: the RPC client hands out a new `rpc.computer` object on every read, so using it
 * as a default would change the effect's deps each render and reload forever.
 */
const LIVE_WIRE: ComputerStatusWire = {
  status: (input) => rpc.computer.status(input),
  host: (input) => rpc.computer.host(input),
  sessionModel: (input) => rpc.engineModels.sessionModel(input),
  runtime: (input) => rpc.computer.runtime(input),
  setAgent: (input) => rpc.computer.setAgent(input),
  moveRunner: (input) => rpc.computer.moveRunner(input),
};

const POLL_MS = 10_000;

const HARNESS_LABEL: Record<string, string> = { "claude-sdk": "Claude Agent SDK", pi: "Pi" };

function message(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** Settings > Computer: where the Conversation runs (the runner) and the harness it runs on. */
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
  const [runtime, setRuntime] = useState<ComputerRuntime | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [folder, setFolder] = useState("");

  const load = useCallback(async () => {
    const [s, h, m, r] = await Promise.allSettled([
      wire.status({ botId }),
      wire.host({ botId }),
      wire.sessionModel({ botId }),
      wire.runtime({ botId }),
    ]);
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
    if (r.status === "fulfilled") setRuntime(r.value);
    setFailed(s.status === "rejected" && h.status === "rejected");
  }, [botId, wire]);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (!cancelled) void load();
    };
    tick();
    const timer = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [load]);

  async function act(run: () => Promise<unknown>, fallback: string) {
    setPending(true);
    setError(null);
    try {
      await run();
      setTarget(null);
      setFolder("");
    } catch (err) {
      setError(message(err, fallback));
    } finally {
      setPending(false);
      void load();
    }
  }

  const stateLabel = (() => {
    if (!status) return failed ? t`Unavailable` : t`Loading…`;
    if (status.launch) return status.launch.stage === "failed" ? t`Failed to start` : t`Starting`;
    if (status.state === "running") return status.runnerReady === false ? t`Starting` : t`Running`;
    if (status.state === "booting") return t`Starting`;
    if (status.state === "error") return t`Needs attention`;
    return host?.hostId || host?.agentName ? t`Sleeping` : t`Not started`;
  })();

  const harnessName = (id: string | null | undefined) => (id ? (HARNESS_LABEL[id] ?? id) : null);
  const harnessId = host?.harness ?? model?.harness ?? null;
  const modelLabel = model
    ? model.model || (model.defaultModel ? t`Default · ${model.defaultModel}` : t`Default`)
    : null;
  const provider = sandboxProvider || status?.kind || null;
  const agents = runtime?.agents ?? [];
  const canPickAgent = agents.length > 1 && runtime?.agent != null;
  const hosts = runtime?.runners.filter((r) => r.kind === "host") ?? [];

  const runnerLabel = (runner: ComputerRunner) =>
    runner.kind === "computer" ? t`Superchat Computer` : runner.name;
  const runnerSub = (runner: ComputerRunner) => {
    const state = runner.online ? t`Online` : t`Offline`;
    return runner.kind === "computer" && runner.provider ? `${runner.provider} · ${state}` : state;
  };

  return (
    <div className="space-y-5" data-testid="computer-status-settings">
      <SettingsGroup
        title={t`Computer`}
        footer={t`The machine your Conversation runs on. It starts when it is needed.`}
      >
        <SettingsRow label={t`Status`} value={stateLabel} />
        {!runtime && host?.hostId ? <SettingsRow label={t`Host`} value={host.hostId} /> : null}
        {provider ? <SettingsRow label={t`Provider`} value={provider} /> : null}
      </SettingsGroup>

      {runtime && runtime.runners.length > 0 ? (
        <SettingsGroup
          title={t`Runs on`}
          footer={
            runtime.managed && hosts.length > 0
              ? t`A Conversation on the Superchat Computer stays there.`
              : undefined
          }
        >
          {runtime.runners.map((runner) => {
            const selected = target === runner.hostId;
            return (
              <div key={runner.hostId ?? "computer"}>
                <button
                  type="button"
                  data-testid={`runner-${runner.hostId ?? "computer"}`}
                  aria-pressed={runner.current}
                  disabled={pending || !runner.movable}
                  onClick={() => {
                    setError(null);
                    setTarget(selected ? null : runner.hostId);
                  }}
                  className={cn(
                    SETTINGS_ROW,
                    "superchat-row-plain text-start transition-colors enabled:hover:bg-selection disabled:cursor-default focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                  )}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-foreground">{runnerLabel(runner)}</span>
                    <span className="block truncate text-[12px] text-ink-3">
                      {runnerSub(runner)}
                    </span>
                  </span>
                  {runner.current ? <Check className="size-4 shrink-0 text-foreground" /> : null}
                </button>
                {selected && runner.hostId ? (
                  <form
                    className={cn(SETTINGS_ROW, "superchat-row-plain gap-2")}
                    onSubmit={(event) => {
                      event.preventDefault();
                      const hostId = runner.hostId as string;
                      const workspace = folder.trim() || undefined;
                      void act(
                        () => wire.moveRunner({ botId, hostId, workspace }),
                        t`Couldn't move there.`,
                      );
                    }}
                  >
                    <Input
                      aria-label={t`Folder on ${runner.name}`}
                      placeholder={t`Home folder`}
                      value={folder}
                      onChange={(event) => setFolder(event.target.value)}
                      className="h-8 flex-1"
                    />
                    <Button type="submit" size="sm" disabled={pending}>
                      {t`Move here`}
                    </Button>
                  </form>
                ) : null}
              </div>
            );
          })}
          {hosts.length === 0 && runtime.connectCommand ? (
            <div className={cn(SETTINGS_ROW, "superchat-row-plain flex-col items-start gap-1")}>
              <span className="text-foreground">{t`Add this computer`}</span>
              <code
                data-testid="connect-host-command"
                className="w-full select-all break-all rounded-md bg-selection px-2 py-1 font-mono text-[12px] text-ink-2"
              >
                {runtime.connectCommand}
              </code>
            </div>
          ) : null}
        </SettingsGroup>
      ) : null}

      <SettingsGroup
        title={t`Harness`}
        footer={
          canPickAgent
            ? runtime?.busy
              ? t`Switch after the current reply.`
              : t`Applies from your next message.`
            : undefined
        }
      >
        {canPickAgent && runtime?.agent ? (
          <SettingsSegmented
            label={t`Harness`}
            testId="harness-picker"
            disabled={pending || runtime.busy}
            value={runtime.agent}
            options={agents.map((agent) => ({
              value: agent.name,
              label: harnessName(agent.harness) ?? agent.name,
            }))}
            onChange={(agent) =>
              void act(() => wire.setAgent({ botId, agent }), t`Couldn't switch the harness.`)
            }
          />
        ) : (
          <SettingsRow label={t`Harness`} value={harnessName(harnessId) ?? "-"} />
        )}
        <SettingsRow label={t`Model`} value={modelLabel ?? "-"} />
      </SettingsGroup>

      {error ? (
        <p role="alert" className="px-1.5 text-[12px] text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
