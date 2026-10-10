import type { Automation, AutomationSchedule } from "@nova/contracts";
import { useCallback, useEffect, useState } from "react";
import { rpc } from "../../lib/rpc";

export type AutomationsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; automations: Automation[] };

/** The calls the sheet makes; the live RPC unless a dev preview supplies its own. */
export type AutomationsWire = Pick<
  typeof rpc.automations,
  "list" | "create" | "update" | "run" | "remove"
>;

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

/** The person's automations (the engine's scheduled tasks) and the actions on them. */
export function useAutomations(
  botId: string,
  enabled: boolean,
  wire: AutomationsWire = rpc.automations,
) {
  const [state, setState] = useState<AutomationsState>({ status: "loading" });

  const refresh = useCallback(async () => {
    try {
      const automations = await wire.list({ botId });
      setState({ status: "ready", automations });
    } catch (error) {
      setState((current) =>
        current.status === "ready" ? current : { status: "error", message: message(error) },
      );
    }
  }, [botId, wire]);

  useEffect(() => {
    if (!enabled) return;
    setState({ status: "loading" });
    void refresh();
  }, [enabled, refresh]);

  const create = useCallback(
    async (input: { name: string; prompt: string; schedule: AutomationSchedule }) => {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      await wire.create({ botId, ...input, timezone });
      await refresh();
    },
    [botId, refresh, wire],
  );
  const setEnabled = useCallback(
    async (id: string, on: boolean) => {
      await wire.update({ botId, id, enabled: on });
      await refresh();
    },
    [botId, refresh, wire],
  );
  const runNow = useCallback(
    async (id: string) => {
      await wire.run({ botId, id });
      await refresh();
    },
    [botId, refresh, wire],
  );
  const remove = useCallback(
    async (id: string) => {
      await wire.remove({ botId, id });
      await refresh();
    },
    [botId, refresh, wire],
  );

  return { state, refresh, create, setEnabled, runNow, remove };
}
