import { Trans, useLingui } from "@lingui/react/macro";
import type { EngineModelCatalog, EngineModelRow } from "@nova/contracts";
import { NativeSelect, NativeSelectOption } from "@nova/ui-web";
import { Cpu } from "lucide-react";
import { useEffect, useState } from "react";
import { errorText } from "../../lib/error-text";
import { rpc } from "../../lib/rpc";
import { SettingsGroup, SettingsRow } from "../../pages/muse/settings/kit";

/** A model as the person reads it: its name, and its family when the name does not say it. */
export function modelOptionLabel(model: Pick<EngineModelRow, "label" | "family">): string {
  const family = model.family;
  return family && !model.label.toLowerCase().includes(family.toLowerCase())
    ? `${model.label} · ${family}`
    : model.label;
}

/** The model a catalog starts a new chat on: the person's own default, else the engine's. */
export function currentDefault(catalog: EngineModelCatalog): string {
  return (
    catalog.models.find((model) => model.isUserDefault)?.id ??
    catalog.defaultModel ??
    catalog.models.find((model) => model.isDefault)?.id ??
    ""
  );
}

function HarnessDefault({
  harness,
  label,
}: {
  harness: string;
  /** Names the harness when the person's Nova could run on more than one. */
  label: string | null;
}) {
  const { t } = useLingui();
  const [catalog, setCatalog] = useState<EngineModelCatalog | null>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void rpc.engineModels
      .catalog({ harness })
      .then((next) => {
        if (cancelled) return;
        setCatalog(next);
        setValue(currentDefault(next));
      })
      .catch((err) => {
        if (!cancelled) setError(errorText(err, t`Could not load models.`));
      });
    return () => {
      cancelled = true;
    };
  }, [harness, t]);

  async function choose(model: string) {
    const before = value;
    setValue(model);
    setError(null);
    try {
      await rpc.engineModels.setDefault({ harness, model });
    } catch (err) {
      setValue(before);
      setError(errorText(err, t`Could not save.`));
    }
  }

  const defaultWord = t`Default`;
  const title = label ? t`Default model · ${label}` : t`Default model`;
  if (!catalog) {
    return error ? <SettingsRow label={title} sub={error} /> : null;
  }
  if (catalog.status !== "ready" || catalog.models.length === 0) {
    return <SettingsRow label={title} sub={catalog.error ?? t`Add a key to choose a model.`} />;
  }
  return (
    <>
      <SettingsRow label={title} icon={{ tone: "indigo", glyph: <Cpu strokeWidth={2.4} /> }}>
        <NativeSelect
          size="sm"
          aria-label={title}
          data-testid={`default-model-${harness}`}
          value={value}
          onChange={(event) => void choose(event.target.value)}
        >
          {catalog.models.map((model) => (
            <NativeSelectOption key={model.id} value={model.id}>
              {model.isDefault
                ? `${modelOptionLabel(model)} · ${defaultWord}`
                : modelOptionLabel(model)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </SettingsRow>
      {error ? (
        <p role="alert" className="px-3 pb-2 text-[12.5px] text-destructive">
          {error}
        </p>
      ) : null}
    </>
  );
}

/** The model new chats start on, for each harness the person's Nova may run. */
export function DefaultModel({ harnesses }: { harnesses: { id: string; label: string }[] }) {
  if (harnesses.length === 0) return null;
  return (
    <SettingsGroup title={<Trans>Model</Trans>}>
      {harnesses.map((harness) => (
        <HarnessDefault
          key={harness.id}
          harness={harness.id}
          label={harnesses.length > 1 ? harness.label : null}
        />
      ))}
    </SettingsGroup>
  );
}
