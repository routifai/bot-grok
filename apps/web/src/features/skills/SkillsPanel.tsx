import { Trans, useLingui } from "@lingui/react/macro";
import type { AgentSkill, AgentSkillCatalogEntry, TaughtSkill } from "@nova/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@nova/ui-web";
import { ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { illustrationUrl } from "../../lib/illustrations";
import { rpc } from "../../lib/rpc";
import { EmptyState, MUSE_INSET_GROUP } from "../../pages/muse/ui/index";
import { SkillReviewSheet } from "./teach/SkillReviewSheet";

/**
 * Library · Skills: what the Muse knows how to do. Skills come from a demonstration (Teach a
 * task), from an offer the person accepted, or from steps they pasted; this lists them and
 * lets the person read, edit or delete each one.
 */
export function SkillsPanel({ botId }: { botId: string }) {
  const { t } = useLingui();
  const [skills, setSkills] = useState<AgentSkillCatalogEntry[] | null>(null);
  const [taught, setTaught] = useState<TaughtSkill[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [openTaughtId, setOpenTaughtId] = useState<string | null>(null);

  async function load() {
    // Taught skills live on the engine; the Library still lists the rest if it is unreachable.
    void rpc.skills
      .list({ botId })
      .then((all) => setTaught(all.filter((skill) => skill.status === "saved")))
      .catch(() => setTaught([]));
    try {
      setSkills(await rpc.agentSkills.list());
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t`Could not load skills.`);
      setSkills([]);
    }
  }

  useEffect(() => {
    void load();
  }, [botId]);

  if (skills === null) {
    return <div className="h-40 animate-pulse rounded-[22px] bg-muted/60" aria-hidden="true" />;
  }
  if (error) return <p className="py-10 text-[14px] text-destructive">{error}</p>;
  // Only what the Muse learned is listed; built-in and plugin skills stay available to it
  // but aren't the person's to manage here.
  const learned = skills.filter((skill) => skill.source === "user");
  if (learned.length === 0 && taught.length === 0) {
    return (
      <EmptyState illustration="light-bulb" headline={t`No skills yet`}>
        {t`When I do something you'll want again, I'll offer to save it. You can also teach me on my computer, or paste steps and ask me to keep them.`}
      </EmptyState>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {taught.length ? (
        <SkillGroup
          title={t`Taught`}
          skills={taught.map((skill) => ({
            id: skill.id,
            name: skill.name || skill.goal,
            description: skill.goal,
          }))}
          onOpen={setOpenTaughtId}
        />
      ) : null}
      {learned.length ? (
        <SkillGroup title={t`Learned`} skills={learned} onOpen={setOpenId} />
      ) : null}
      {openTaughtId ? (
        <SkillReviewSheet
          skillId={openTaughtId}
          open
          onOpenChange={(open) => {
            if (!open) setOpenTaughtId(null);
          }}
          onChanged={() => load()}
        />
      ) : null}
      {openId ? (
        <SkillSheet
          skillId={openId}
          onClose={() => setOpenId(null)}
          onChanged={() => void load()}
        />
      ) : null}
    </div>
  );
}

function SkillGroup({
  title,
  skills,
  onOpen,
}: {
  title: string;
  skills: { id: string; name: string; description: string }[];
  onOpen: (id: string) => void;
}) {
  return (
    <section>
      <h2 className="px-1 pb-2.5 text-[15px] font-medium text-muted-foreground">{title}</h2>
      <ul className={MUSE_INSET_GROUP}>
        {skills.map((skill, index) => (
          <li key={skill.id}>
            <button
              type="button"
              onClick={() => onOpen(skill.id)}
              className="group flex w-full items-center gap-4 px-4 text-start transition-colors hover:bg-accent/50 active:bg-accent"
            >
              <img
                src={illustrationUrl("spiral-notepad")}
                alt=""
                loading="lazy"
                className="size-9 shrink-0"
              />
              <span
                className={`flex min-w-0 flex-1 items-center gap-3 py-3.5 ${index > 0 ? "border-t border-border/70" : ""}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[16px] font-medium tracking-[-0.01em] text-foreground">
                    {skill.name}
                  </span>
                  <span className="mt-0.5 line-clamp-2 block text-[14px] leading-[1.45] text-muted-foreground">
                    {skill.description}
                  </span>
                </span>
                <ChevronRight
                  size={18}
                  strokeWidth={2}
                  aria-hidden="true"
                  className="shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5"
                />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SkillSheet({
  skillId,
  onClose,
  onChanged,
}: {
  skillId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useLingui();
  const [skill, setSkill] = useState<AgentSkill | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void rpc.agentSkills
      .get({ skillId })
      .then((loaded) => {
        if (cancelled) return;
        setSkill(loaded);
        setDraft(loaded.content);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : t`Could not open this skill.`);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [skillId, t]);

  async function save() {
    if (!skill) return;
    setBusy(true);
    setError(null);
    try {
      setSkill(await rpc.agentSkills.update({ skillId: skill.id, content: draft }));
      onChanged();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t`Could not save.`);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!skill) return;
    setBusy(true);
    try {
      await rpc.agentSkills.remove({ skillId: skill.id });
      onChanged();
      onClose();
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : t`Could not delete.`);
      setBusy(false);
    }
  }

  const editable = skill ? !skill.readOnly : false;
  const dirty = skill ? draft !== skill.content : false;

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="flex w-full flex-col gap-0 data-[side=right]:sm:inset-y-3 data-[side=right]:sm:right-3 data-[side=right]:sm:h-auto data-[side=right]:sm:max-w-[560px] data-[side=right]:sm:rounded-3xl data-[side=right]:sm:border data-[side=right]:sm:border-border data-[side=right]:sm:shadow-float">
        <SheetHeader className="px-6 pt-6 pb-2">
          <SheetTitle className="text-[22px] font-semibold tracking-[-0.01em] text-foreground">
            {skill?.name ?? t`Skill`}
          </SheetTitle>
          {skill ? (
            <p className="text-[14px] leading-[1.45] text-muted-foreground">{skill.description}</p>
          ) : null}
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 pt-3 pb-6">
          {skill ? (
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              readOnly={!editable}
              aria-label={t`Skill instructions`}
              spellCheck={false}
              className="min-h-[320px] flex-1 resize-none rounded-2xl bg-muted/60 p-4 font-mono text-[13px] leading-[1.55] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          ) : error ? null : (
            <div className="min-h-[320px] flex-1 animate-pulse rounded-2xl bg-muted/60" />
          )}
          {error ? (
            <p role="alert" className="text-[13px] text-destructive">
              {error}
            </p>
          ) : null}
          {editable ? (
            <div className="flex items-center justify-between gap-3">
              <Button
                variant="ghost"
                className="rounded-full text-destructive"
                disabled={busy}
                onClick={() => setConfirmDelete(true)}
              >
                <Trans>Delete</Trans>
              </Button>
              <Button
                className="rounded-full"
                disabled={busy || !dirty}
                onClick={() => void save()}
              >
                <Trans>Save changes</Trans>
              </Button>
            </div>
          ) : skill ? (
            <p className="text-[13px] text-muted-foreground">
              <Trans>Built-in skills can't be edited.</Trans>
            </p>
          ) : null}
        </div>
      </SheetContent>
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Delete this skill?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>It won't be used anymore. This can't be undone.</Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans>Keep it</Trans>
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => void remove()}>
              <Trans>Delete</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  );
}
