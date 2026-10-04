import type { SkillDraft, TaughtSkill } from "@aiden/contracts";
import { formatSkillRunPrompt } from "@aiden/core";
import {
  Button,
  Input,
  Label,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  Switch,
  Textarea,
} from "@aiden/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { ORPCError } from "@orpc/client";
import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import { Shimmer } from "../ai/primitives";

const POLL_MS = 2500;

/** The engine's skill, re-read while its draft is being written. */
export function useTaughtSkill(skillId: string, enabled = true) {
  const [skill, setSkill] = useState<TaughtSkill | null>(null);
  const [error, setError] = useState(false);
  const [gone, setGone] = useState(false);
  const status = skill?.status;

  const reload = useCallback(async () => {
    try {
      setSkill(await rpc.skills.get({ skillId }));
      setError(false);
      setGone(false);
    } catch (e) {
      // NOT_FOUND: a draft from before teaching moved to the engine; nothing to retry.
      setGone(e instanceof ORPCError && e.code === "NOT_FOUND");
      setError(true);
    }
  }, [skillId]);

  useEffect(() => {
    if (enabled) void reload();
  }, [enabled, reload]);

  useEffect(() => {
    if (!enabled || (status !== "drafting" && status !== "recording")) return;
    const timer = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, status, reload]);

  return { skill, error, gone, reload };
}

const emptyDraft: SkillDraft = { preconditions: [], inputs: [], steps: [], returns: "" };

/**
 * Review a taught skill: its steps with a thumbnail of the screen after each, the inputs it
 * takes, and what needs asking first. Edit, test it on the Computer, keep it or throw it away.
 */
export function SkillReviewSheet({
  skillId,
  open,
  onOpenChange,
  onChanged,
  onAddRoutine,
}: {
  skillId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void | Promise<void>;
  onAddRoutine?: (name: string, prompt: string) => void;
}) {
  const { t } = useLingui();
  const { skill, error, reload } = useTaughtSkill(skillId, open);
  const [name, setName] = useState("");
  const [draft, setDraft] = useState<SkillDraft>(emptyDraft);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const loadedVersion = useRef<string>("");

  // Adopt the engine's draft when it arrives or a save changes it.
  const version = skill ? `${skill.id}:${skill.status}:${skill.updatedAt}` : "";
  useEffect(() => {
    if (!skill?.draft || loadedVersion.current === version) return;
    loadedVersion.current = version;
    setName(skill.name);
    setDraft(skill.draft);
  }, [skill, version]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setProblem(null);
    try {
      await action();
    } catch (failure) {
      setProblem(failure instanceof Error ? failure.message : t`Something went wrong.`);
    } finally {
      setBusy(false);
    }
  }

  const persist = () => rpc.skills.updateDraft({ skillId, name, draft });
  const saved = skill?.status === "saved";
  const ready = skill?.status === "draft" || saved;

  const changeStep = (index: number, patch: Partial<SkillDraft["steps"][number]>) =>
    setDraft((current) => ({
      ...current,
      steps: current.steps.map((step, i) => (i === index ? { ...step, ...patch } : step)),
    }));

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 data-[side=right]:sm:inset-y-3 data-[side=right]:sm:right-3 data-[side=right]:sm:h-auto data-[side=right]:sm:max-w-[560px] data-[side=right]:sm:rounded-3xl data-[side=right]:sm:border data-[side=right]:sm:border-border data-[side=right]:sm:shadow-float">
        <SheetHeader className="px-6 pt-6 pb-2">
          <SheetTitle className="text-[22px] font-semibold tracking-[-0.01em] text-foreground">
            <Trans>Skill</Trans>
          </SheetTitle>
          <SheetDescription className="truncate">{skill?.goal ?? ""}</SheetDescription>
        </SheetHeader>
        <div className="rk-scroll flex flex-1 flex-col gap-5 overflow-y-auto px-6 pb-4">
          {!skill ? (
            error ? (
              <p role="alert" className="text-[14px] text-destructive">
                <Trans>Could not open this skill.</Trans>
              </p>
            ) : (
              <div className="h-48 animate-pulse rounded-2xl bg-muted/60" aria-hidden="true" />
            )
          ) : skill.status === "recording" || skill.status === "drafting" ? (
            <p className="py-10 text-[15px]">
              <Shimmer>
                {skill.status === "recording" ? t`Watching you work…` : t`Writing the draft…`}
              </Shimmer>
            </p>
          ) : skill.status === "failed" || !skill.draft ? (
            <p className="py-10 text-[14px] text-muted-foreground">
              <Trans>I couldn't turn that into a skill. Discard it and show me again.</Trans>
            </p>
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                <Label
                  htmlFor="skill-name"
                  className="text-[13px] font-normal text-muted-foreground"
                >
                  <Trans>Name</Trans>
                </Label>
                <Input id="skill-name" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <ol className="flex flex-col gap-3" aria-label={t`Steps`}>
                {draft.steps.map((step, index) => {
                  const frame = step.keyframe ? skill.keyframes?.[step.keyframe] : undefined;
                  return (
                    <li
                      key={index}
                      className="flex gap-3 rounded-2xl border border-border bg-card p-3"
                    >
                      <span className="mt-1 w-5 shrink-0 text-end text-[13px] tabular-nums text-muted-foreground">
                        {index + 1}
                      </span>
                      <div className="flex min-w-0 flex-1 flex-col gap-2">
                        {frame ? (
                          <img
                            src={frame}
                            alt=""
                            className="aspect-video w-full rounded-lg border border-border object-cover object-top"
                          />
                        ) : null}
                        <Textarea
                          aria-label={t`Step ${index + 1}`}
                          value={step.intent}
                          rows={2}
                          onChange={(e) => changeStep(index, { intent: e.target.value })}
                        />
                        <Input
                          aria-label={t`How to tell step ${index + 1} worked`}
                          placeholder={t`How I'll know it worked`}
                          value={step.check}
                          onChange={(e) => changeStep(index, { check: e.target.value })}
                        />
                        <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
                          <Switch
                            size="sm"
                            aria-label={t`Ask me first before step ${index + 1}`}
                            checked={step.approval}
                            onCheckedChange={(checked) => changeStep(index, { approval: checked })}
                          />
                          <span aria-hidden="true">
                            <Trans>Ask me first</Trans>
                          </span>
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t`Remove step ${index + 1}`}
                        onClick={() =>
                          setDraft((c) => ({ ...c, steps: c.steps.filter((_, i) => i !== index) }))
                        }
                      >
                        <X size={15} />
                      </Button>
                    </li>
                  );
                })}
              </ol>
              <Button
                variant="outline"
                size="sm"
                className="self-start"
                onClick={() =>
                  setDraft((c) => ({
                    ...c,
                    steps: [...c.steps, { intent: "", check: "", approval: false, keyframe: null }],
                  }))
                }
              >
                <Trans>Add step</Trans>
              </Button>
              {draft.inputs.length ? (
                <section className="flex flex-col gap-2">
                  <h3 className="text-[13px] font-normal text-muted-foreground">
                    <Trans>Changes each time</Trans>
                  </h3>
                  {draft.inputs.map((input, index) => (
                    <div key={input.name} className="flex items-center gap-2">
                      <Input
                        aria-label={t`Name of ${input.name}`}
                        className="w-2/5"
                        value={input.label}
                        onChange={(e) =>
                          setDraft((c) => ({
                            ...c,
                            inputs: c.inputs.map((it, i) =>
                              i === index ? { ...it, label: e.target.value } : it,
                            ),
                          }))
                        }
                      />
                      <Input
                        aria-label={t`Example for ${input.name}`}
                        value={input.default}
                        onChange={(e) =>
                          setDraft((c) => ({
                            ...c,
                            inputs: c.inputs.map((it, i) =>
                              i === index ? { ...it, default: e.target.value } : it,
                            ),
                          }))
                        }
                      />
                    </div>
                  ))}
                </section>
              ) : null}
            </>
          )}
          {problem ? (
            <p role="alert" className="text-[13px] text-destructive">
              {problem}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-6 py-4">
          {ready ? (
            <>
              <Button
                disabled={busy || draft.steps.length === 0}
                onClick={() =>
                  void run(async () => {
                    await persist();
                    await rpc.skills.save({ skillId, name });
                    await reload();
                    await onChanged();
                  })
                }
              >
                {saved ? <Trans>Save changes</Trans> : <Trans>Save</Trans>}
              </Button>
              <Button
                variant="outline"
                disabled={busy || draft.steps.length === 0}
                onClick={() =>
                  void run(async () => {
                    await persist();
                    await rpc.skills.testRun({ skillId });
                    onOpenChange(false);
                    await onChanged();
                  })
                }
              >
                <Trans>Test</Trans>
              </Button>
              {onAddRoutine && skill ? (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    onAddRoutine(
                      name || skill.name,
                      formatSkillRunPrompt(name || skill.name, skill.playbook),
                    )
                  }
                >
                  <Trans>Add to routine</Trans>
                </Button>
              ) : null}
            </>
          ) : null}
          {skill && skill.status !== "recording" ? (
            <Button
              variant="ghost"
              className="ms-auto text-destructive"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await rpc.skills.remove({ skillId });
                  onOpenChange(false);
                  await onChanged();
                })
              }
            >
              <Trans>Discard</Trans>
            </Button>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
