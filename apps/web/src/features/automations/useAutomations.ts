import type { Automation, AutomationSchedule } from "@nova/contracts";
import { useCallback, useEffect, useState } from "react";
import { rpc } from "../../lib/rpc";

export type AutomationsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; automations: Automation[] };

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

/** The person's automations (the engine's scheduled tasks) and the actions on them. */
export function useAutomations(botId: string, enabled: boolean) {
  const [state, setState] = useState<AutomationsState>({ status: "loading" });

  const refresh = useCallback(async () => {
    try {
      const automations = await rpc.automations.list({ botId });
      setState({ status: "ready", automations });
    } catch (error) {
      setState((current) =>
        current.status === "ready" ? current : { status: "error", message: message(error) },
      );
    }
  }, [botId]);

  useEffect(() => {
    if (!enabled) return;
    setState({ status: "loading" });
    void refresh();
  }, [enabled, refresh]);

  const create = useCallback(
    async (input: { name: string; prompt: string; schedule: AutomationSchedule }) => {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      await rpc.automations.create({ botId, ...input, timezone });
      await refresh();
    },
    [botId, refresh],
  );
  const setEnabled = useCallback(
    async (id: string, on: boolean) => {
      await rpc.automations.update({ botId, id, enabled: on });
      await refresh();
    },
    [botId, refresh],
  );
  const runNow = useCallback(
    async (id: string) => {
      await rpc.automations.run({ botId, id });
      await refresh();
    },
    [botId, refresh],
  );
  const remove = useCallback(
    async (id: string) => {
      await rpc.automations.remove({ botId, id });
      await refresh();
    },
    [botId, refresh],
  );

  return { state, refresh, create, setEnabled, runNow, remove };
}
