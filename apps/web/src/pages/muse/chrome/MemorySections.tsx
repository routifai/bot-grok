import { useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { addressMemoryItem } from "./memoryProfile";

export type MemoryClaim = {
  id: string;
  kind: string;
  text: string;
  origin: "said" | "edited" | "noticed";
  personAuthored: boolean;
  date: number;
};

/** The Memory tab's claim wire: `rpc.memory.claims` / `editClaim` / `forgetClaim`. */
export type ClaimsWire = {
  claims: (input: { botId: string }) => Promise<{ claims: MemoryClaim[] }>;
  editClaim: (input: { botId: string; claimId: string; text: string }) => Promise<MemoryClaim>;
  forgetClaim: (input: { botId: string; claimId: string }) => Promise<{ ok: true }>;
};

/** Which claim kinds each section shows, in reading order. */
export const MEMORY_SECTIONS = [
  { id: "about", kinds: ["fact", "preference", "instruction"] },
  { id: "commitments", kinds: ["commitment"] },
  { id: "projects", kinds: ["project", "decision"] },
  { id: "people", kinds: ["person"] },
  { id: "working", kinds: ["working_style"] },
] as const;

export type SectionId = (typeof MEMORY_SECTIONS)[number]["id"];

export function groupClaims(
  claims: MemoryClaim[],
): Array<{ id: SectionId; claims: MemoryClaim[] }> {
  return MEMORY_SECTIONS.map((section) => ({
    id: section.id,
    claims: claims.filter((claim) => (section.kinds as readonly string[]).includes(claim.kind)),
  })).filter((section) => section.claims.length > 0);
}

function Claim({
  botId,
  claim,
  wire,
  onChanged,
  onRemoved,
}: {
  botId: string;
  claim: MemoryClaim;
  wire: ClaimsWire;
  onChanged: (claim: MemoryClaim) => void;
  onRemoved: (id: string) => void;
}) {
  const { t } = useLingui();
  const [draft, setDraft] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setFailed(false);
    try {
      await action();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const source =
    claim.origin === "edited" ? t`You edited` : claim.origin === "said" ? t`You said` : t`Noticed`;
  const when = new Date(claim.date * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });

  return (
    <li className="group rounded-lg px-2 py-1" data-testid="memory-claim">
      {draft !== null ? (
        <div className="flex flex-col gap-1.5">
          <textarea
            className="min-h-16 rounded-lg border border-border bg-background px-2 py-1 text-[13.5px] leading-[1.5]"
            dir="auto"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="flex gap-3 text-[12.5px]">
            <button
              type="button"
              disabled={busy || draft.trim() === ""}
              onClick={() =>
                void run(async () => {
                  onChanged(await wire.editClaim({ botId, claimId: claim.id, text: draft.trim() }));
                  setDraft(null);
                })
              }
            >
              {t`Save`}
            </button>
            <button
              type="button"
              className="text-muted-foreground"
              disabled={busy}
              onClick={() => setDraft(null)}
            >
              {t`Cancel`}
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="text-[13.5px] leading-[1.5] text-foreground" dir="auto">
            {addressMemoryItem(claim.text)}
          </p>
          <div className="flex items-baseline gap-2 text-[12px] text-muted-foreground">
            <span>
              {source} · {when}
            </span>
            <span className="ml-auto flex gap-3 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
              {confirming ? (
                <>
                  <button
                    type="button"
                    className="hover:text-foreground"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await wire.forgetClaim({ botId, claimId: claim.id });
                        onRemoved(claim.id);
                      })
                    }
                  >
                    {t`Delete`}
                  </button>
                  <button type="button" onClick={() => setConfirming(false)}>
                    {t`Cancel`}
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="hover:text-foreground"
                    onClick={() => setDraft(claim.text)}
                  >
                    {t`Edit`}
                  </button>
                  <button
                    type="button"
                    className="hover:text-foreground"
                    onClick={() => setConfirming(true)}
                  >
                    {t`Delete`}
                  </button>
                </>
              )}
            </span>
          </div>
          {failed ? <p className="text-[12px] text-destructive">{t`Could not save`}</p> : null}
        </>
      )}
    </li>
  );
}

/** The Memory tab's editable sections: About you, Commitments, Projects & focus, People, How
 * Nova works with you. Each item shows its source and date; an edit marks it person-authored
 * (the engine's upkeep and Helpers never overwrite it); delete forgets it. */
export function MemorySections({
  botId,
  wire,
  claims,
  onChange,
}: {
  botId: string;
  wire: ClaimsWire;
  claims: MemoryClaim[];
  onChange: (next: MemoryClaim[]) => void;
}) {
  const { t } = useLingui();
  const titles: Record<SectionId, string> = {
    about: t`About you`,
    commitments: t`Commitments`,
    projects: t`Projects & focus`,
    people: t`People`,
    working: t`How Nova works with you`,
  };
  return (
    <>
      {groupClaims(claims).map((section) => (
        <section
          key={section.id}
          className="flex flex-col gap-1"
          data-testid={`memory-section-${section.id}`}
        >
          <h3 className="px-1 text-[12.5px] font-semibold text-muted-foreground">
            {titles[section.id]}
          </h3>
          <ul className="flex flex-col gap-0.5">
            {section.claims.map((claim) => (
              <Claim
                key={claim.id}
                botId={botId}
                claim={claim}
                wire={wire}
                onChanged={(saved) => onChange(claims.map((c) => (c.id === saved.id ? saved : c)))}
                onRemoved={(id) => onChange(claims.filter((c) => c.id !== id))}
              />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
