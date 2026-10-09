import { Trans, useLingui } from "@lingui/react/macro";
import { Button, Checkbox, NativeSelect, NativeSelectOption, Switch } from "@nova/ui-web";
import { useEffect, useState } from "react";
import { errorText } from "../../../lib/engine-models";
import { rpc } from "../../../lib/rpc";
import { modelOptionLabel } from "./DefaultModel";
import { SettingsGroup, SettingsRow } from "./kit";

type Catalog = Awaited<ReturnType<typeof rpc.engineAdmin.modelsCatalog>>;
type Draft = { all: boolean; allow: string[]; default: string | null };
type Drafts = Record<string, Draft>;

/** The overlay the engine keeps for a draft: a harness with no restriction and no default is
 * simply absent (the engine replaces the whole overlay). */
export function overlayFromDrafts(drafts: Drafts) {
  const overlay: Record<string, { allow: string[] | null; default: string | null }> = {};
  for (const [harness, draft] of Object.entries(drafts)) {
    const allow = draft.all ? null : draft.allow;
    const chosen =
      draft.default && (allow === null || allow.includes(draft.default)) ? draft.default : null;
    if (allow === null && chosen === null) continue;
    overlay[harness] = { allow, default: chosen };
  }
  return overlay;
}

function HarnessModels({
  title,
  catalog,
  draft,
  onChange,
}: {
  title: string | null;
  catalog: Catalog;
  draft: Draft;
  onChange: (next: Draft) => void;
}) {
  const { t } = useLingui();
  const offered = draft.all
    ? catalog.models
    : catalog.models.filter((model) => draft.allow.includes(model.id));
  const heading = title ? t`Allowed models · ${title}` : t`Allowed models`;
  return (
    <SettingsGroup title={heading}>
      <SettingsRow label={<Trans>All models</Trans>}>
        <Switch
          aria-label={t`All models`}
          checked={draft.all}
          onCheckedChange={(all) =>
            onChange({
              ...draft,
              all,
              allow: draft.allow.length ? draft.allow : catalog.models.map((model) => model.id),
            })
          }
        />
      </SettingsRow>
      {draft.all
        ? null
        : catalog.models.map((model) => {
            const checked = draft.allow.includes(model.id);
            return (
              <SettingsRow key={model.id} label={modelOptionLabel(model)}>
                <Checkbox
                  aria-label={modelOptionLabel(model)}
                  checked={checked}
                  onCheckedChange={(on) => {
                    const allow = on
                      ? [...draft.allow, model.id]
                      : draft.allow.filter((id) => id !== model.id);
                    onChange({
                      ...draft,
                      allow,
                      default:
                        draft.default && allow.includes(draft.default) ? draft.default : null,
                    });
                  }}
                />
              </SettingsRow>
            );
          })}
      <SettingsRow label={<Trans>Default for everyone</Trans>}>
        <NativeSelect
          size="sm"
          aria-label={t`Default for everyone`}
          value={draft.default ?? ""}
          onChange={(event) => onChange({ ...draft, default: event.target.value || null })}
        >
          <NativeSelectOption value="">{t`Engine default`}</NativeSelectOption>
          {offered.map((model) => (
            <NativeSelectOption key={model.id} value={model.id}>
              {modelOptionLabel(model)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </SettingsRow>
    </SettingsGroup>
  );
}

/**
 * Which models the organization offers, per harness: all of them or a chosen few, and the
 * default new chats start on. Picked from the harness binding's whole list (the engine keeps
 * the rest out of everyone's pickers).
 */
export function OrgModels({ harnesses }: { harnesses: { id: string; label: string }[] }) {
  const { t } = useLingui();
  const [catalogs, setCatalogs] = useState<Record<string, Catalog>>({});
  const [drafts, setDrafts] = useState<Drafts>({});
  const [saved, setSaved] = useState<string>("{}");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      rpc.engineAdmin.models(),
      Promise.all(
        harnesses.map((harness) =>
          rpc.engineAdmin.modelsCatalog({ harness: harness.id }).catch(() => null),
        ),
      ),
    ])
      .then(([overlay, loaded]) => {
        if (cancelled) return;
        const nextCatalogs: Record<string, Catalog> = {};
        const nextDrafts: Drafts = {};
        harnesses.forEach((harness, index) => {
          const catalog = loaded[index];
          if (catalog?.status !== "ready") return;
          nextCatalogs[harness.id] = catalog;
          const entry = overlay[harness.id];
          nextDrafts[harness.id] = {
            all: entry?.allow == null,
            allow: entry?.allow ?? [],
            default: entry?.default ?? null,
          };
        });
        setCatalogs(nextCatalogs);
        setDrafts(nextDrafts);
        setSaved(JSON.stringify(overlayFromDrafts(nextDrafts)));
      })
      .catch((err) => {
        if (!cancelled) setError(errorText(err, t`Could not load models.`));
      });
    return () => {
      cancelled = true;
    };
  }, [harnesses, t]);

  const shown = harnesses.filter((harness) => catalogs[harness.id] && drafts[harness.id]);
  const incomplete = Object.values(drafts).some((draft) => !draft.all && draft.allow.length === 0);
  const dirty = JSON.stringify(overlayFromDrafts(drafts)) !== saved;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const overlay = overlayFromDrafts(drafts);
      await rpc.engineAdmin.setModels({ harnesses: overlay });
      setSaved(JSON.stringify(overlay));
    } catch (err) {
      setError(errorText(err, t`Could not save.`));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="org-models" className="flex flex-col gap-6">
      {shown.map((harness) => {
        const catalog = catalogs[harness.id];
        const draft = drafts[harness.id];
        if (!catalog || !draft) return null;
        return (
          <HarnessModels
            key={harness.id}
            title={harnesses.length > 1 ? harness.label : null}
            catalog={catalog}
            draft={draft}
            onChange={(next) => setDrafts((current) => ({ ...current, [harness.id]: next }))}
          />
        );
      })}
      {error ? (
        <p role="alert" className="text-[12.5px] text-destructive">
          {error}
        </p>
      ) : null}
      {shown.length ? (
        <div>
          <Button disabled={!dirty || incomplete || busy} onClick={() => void save()}>
            {busy ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
