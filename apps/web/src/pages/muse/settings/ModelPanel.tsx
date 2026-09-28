import type { ModelCatalogEntry } from "@aiden/contracts";
import { Skeleton } from "@aiden/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { rpc } from "../../../lib/rpc";
import { SettingsGroup, SettingsRow } from "./kit";

/**
 * Settings > Model: which model Nova thinks with. Models and their keys are configured on
 * the server (`.env`), so this only shows what is in use.
 */
export function ModelPanel() {
  const { t } = useLingui();
  const [state, setState] = useState<
    | { status: "loading" }
    | {
        status: "ready";
        model: ModelCatalogEntry | null;
        provider: string | null;
        id: string | null;
      }
    | { status: "error" }
  >({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    void Promise.all([rpc.me(), rpc.models.list().catch(() => [] as ModelCatalogEntry[])])
      .then(([me, catalog]) => {
        if (cancelled) return;
        const model =
          catalog.find(
            (entry) => entry.provider === me.defaultProvider && entry.id === me.defaultModel,
          ) ?? null;
        setState({ status: "ready", model, provider: me.defaultProvider, id: me.defaultModel });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === "loading") return <Skeleton className="h-[106px] w-full rounded-[22px]" />;
  if (state.status === "error") {
    return <p className="px-4 text-[13px] text-destructive">{t`Could not load the model.`}</p>;
  }

  const name = state.model?.label ?? state.id;
  const provider = state.model?.providerName ?? state.provider;
  return (
    <SettingsGroup
      footer={
        <Trans>
          Models and their keys are set on the server, in the .env file. Restart Nova after changing
          them.
        </Trans>
      }
    >
      <SettingsRow label={<Trans>Model</Trans>} value={name ?? t`Not set`} />
      {provider ? <SettingsRow label={<Trans>Provider</Trans>} value={provider} /> : null}
    </SettingsGroup>
  );
}
