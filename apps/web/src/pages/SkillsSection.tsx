import { Trans, useLingui } from "@lingui/react/macro";
import type { AgentSkill, AgentSkillCatalogEntry } from "@nova/contracts";
import { Button, Skeleton, Textarea } from "@nova/ui-web";
import { useEffect, useRef, useState } from "react";
import { rpc } from "../lib/rpc";

const fieldClass = "mt-2 w-full font-mono text-[13px] leading-relaxed";

function rowClass(open: boolean): string {
  return `h-auto w-full justify-start whitespace-normal px-2.5 py-2.5 text-start ${open ? "bg-muted" : ""}`;
}

const NEW_SKILL_TEMPLATE = `---
name: my-skill
description: What this skill does and when the agent should use it.
---

Steps the agent should follow.
`;

/** The current user's agent skills in this space: read, write, create and delete. */
export function SkillsSection({
  onSkillsChange,
}: {
  onSkillsChange: (skills: AgentSkillCatalogEntry[]) => void;
}) {
  const { t } = useLingui();
  const [loading, setLoading] = useState(true);
  const [skills, setSkills] = useState<AgentSkillCatalogEntry[]>([]);
  const [open, setOpen] = useState<AgentSkill | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const generation = useRef(0);
  const selection = useRef(0);

  async function refresh() {
    const current = ++generation.current;
    const list = await rpc.agentSkills.list();
    if (current !== generation.current) return;
    setSkills(list);
    onSkillsChange(list);
  }

  useEffect(() => {
    const current = ++generation.current;
    void rpc.agentSkills
      .list()
      .then((list) => {
        if (current !== generation.current) return;
        setSkills(list);
        setLoading(false);
      })
      .catch(() => {
        if (current !== generation.current) return;
        setSkills([]);
        setLoading(false);
        setError(t`Could not load`);
      });
    return () => {
      generation.current += 1;
      selection.current += 1;
    };
  }, [t]);

  async function openSkill(entry: AgentSkillCatalogEntry) {
    if (busy) return;
    const current = ++selection.current;
    setCreating(false);
    setConfirmingDelete(false);
    setError(null);
    try {
      const skill = await rpc.agentSkills.get({ skillId: entry.id });
      // A slower response must not clobber a newer selection or a fresh draft.
      if (current !== selection.current) return;
      setOpen(skill);
      setDraft(skill.content);
    } catch {
      if (current !== selection.current) return;
      setError(t`Could not load skill`);
    }
  }

  async function save() {
    if (busy || !draft.trim()) return;
    setBusy(true);
    setError(null);
    try {
      if (creating) {
        await rpc.agentSkills.create({ content: draft });
      } else if (open) {
        await rpc.agentSkills.update({ skillId: open.id, content: draft });
      }
      setOpen(null);
      setCreating(false);
      setConfirmingDelete(false);
      try {
        await refresh();
      } catch {
        setError(t`Could not load`);
      }
    } catch {
      setError(t`Could not save skill`);
    } finally {
      setBusy(false);
    }
  }

  async function remove(skill: AgentSkill) {
    if (busy) return;
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    const skillId = skill.id;
    setBusy(true);
    setError(null);
    try {
      await rpc.agentSkills.remove({ skillId });
      if (open?.id === skillId) {
        setOpen(null);
        setConfirmingDelete(false);
      }
      try {
        await refresh();
      } catch {
        setError(t`Could not load`);
      }
    } catch {
      setError(t`Could not delete skill`);
    } finally {
      setBusy(false);
    }
  }

  const editorOpen = creating || open;
  return (
    <section className="mt-6" data-testid="bot-skills">
      <h3 className="mb-2 text-[12.5px] uppercase tracking-[0.08em] text-muted-foreground">
        <Trans>Skills</Trans>
      </h3>
      {error ? <div className="px-2.5 pb-2 text-[13px] text-destructive">{error}</div> : null}
      {loading ? <Skeleton className="h-10 w-full" /> : null}
      {!loading && skills.length === 0 && !editorOpen && !error ? (
        <div className="px-2.5 py-1 text-[13.5px] text-muted-foreground">
          <Trans>No skills yet</Trans>
        </div>
      ) : null}
      {!editorOpen
        ? skills.map((entry) => (
            <Button
              variant="ghost"
              key={entry.id}
              type="button"
              disabled={busy}
              onClick={() => void openSkill(entry)}
              className={`${rowClass(false)} block`}
            >
              <span className="flex w-full items-baseline justify-between gap-3">
                <span className="min-w-0 truncate text-[14px] text-foreground" dir="auto">
                  {entry.name}
                </span>
                {entry.readOnly ? (
                  <span className="shrink-0 text-[12px] text-muted-foreground">
                    <Trans>read-only</Trans>
                  </span>
                ) : null}
              </span>
              <span
                className="mt-0.5 block truncate text-[12.5px] text-muted-foreground"
                dir="auto"
              >
                {entry.description}
              </span>
            </Button>
          ))
        : null}
      {editorOpen ? (
        <div className="px-2.5 pb-2">
          {open ? (
            <div className="pb-1 text-[14px] text-foreground" dir="auto">
              {open.name}
            </div>
          ) : null}
          <Textarea
            aria-label="SKILL.md"
            disabled={busy}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={Math.min(20, Math.max(8, draft.split("\n").length + 1))}
            readOnly={Boolean(open?.readOnly)}
            className={fieldClass}
            dir="auto"
          />
          <div className="mt-2 flex items-center gap-2">
            {!open?.readOnly ? (
              <Button
                variant="ghost"
                type="button"
                disabled={busy || !draft.trim() || (!creating && draft === open?.content)}
                onClick={() => void save()}
                className="rounded-lg bg-muted px-3 py-1.5 text-[13px] text-foreground disabled:opacity-50"
              >
                <Trans>Save</Trans>
              </Button>
            ) : null}
            <Button
              variant="ghost"
              type="button"
              disabled={busy}
              onClick={() => {
                selection.current += 1;
                setOpen(null);
                setCreating(false);
                setConfirmingDelete(false);
              }}
              className="rounded-lg px-3 py-1.5 text-[13px] text-muted-foreground"
            >
              {open?.readOnly ? <Trans>Close</Trans> : <Trans>Cancel</Trans>}
            </Button>
            {open && !open.readOnly ? (
              <Button
                variant="ghost"
                type="button"
                disabled={busy}
                onClick={() => void remove(open)}
                className={`ms-auto rounded-lg px-3 py-1.5 text-[13px] ${
                  confirmingDelete ? "bg-destructive/10 text-destructive" : "text-destructive"
                }`}
              >
                {confirmingDelete ? <Trans>Confirm delete</Trans> : <Trans>Delete</Trans>}
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <Button
          variant="ghost"
          type="button"
          disabled={busy}
          onClick={() => {
            selection.current += 1;
            setOpen(null);
            setCreating(true);
            setConfirmingDelete(false);
            setDraft(NEW_SKILL_TEMPLATE);
            setError(null);
          }}
          className="mt-2 px-2.5 text-[13px] text-muted-foreground hover:text-foreground"
        >
          <Trans>New skill</Trans>
        </Button>
      )}
    </section>
  );
}
