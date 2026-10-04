import type { SkillPlaybook } from "@aiden/contracts";
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
  Textarea,
} from "@aiden/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { rpc } from "../../lib/rpc";

type SkillDraftBlock = {
  kind: "skill_draft";
  skillId: string;
  name: string;
  goal: string;
  playbook: SkillPlaybook;
  status: "draft" | "saved";
};

function fieldLabel(id: string, title: React.ReactNode) {
  return (
    <Label htmlFor={id} className="mt-3 mb-1 text-[13px] font-normal text-muted-foreground">
      {title}
    </Label>
  );
}

export function SkillDraftCard({
  block,
  onRefresh,
  onAddRoutine,
}: {
  block: SkillDraftBlock;
  onRefresh: () => Promise<void>;
  onAddRoutine: (name: string, prompt: string) => void;
}) {
  const [name, setName] = useState(block.name);
  const [playbook, setPlaybook] = useState(block.playbook);
  const [saved, setSaved] = useState(block.status === "saved");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const { t } = useLingui();

  useEffect(() => {
    setName(block.name);
    setPlaybook(block.playbook);
    setSaved(block.status === "saved");
  }, [block.skillId, block.status]);

  async function saveDraft() {
    setBusy(true);
    try {
      await rpc.skills.updateDraft({ skillId: block.skillId, name, playbook });
      await rpc.skills.save({ skillId: block.skillId, name });
      setSaved(true);
      await onRefresh();
    } finally {
      setBusy(false);
    }
  }

  async function discardDraft() {
    setBusy(true);
    try {
      await rpc.skills.remove({ skillId: block.skillId });
      await onRefresh();
    } finally {
      setBusy(false);
    }
  }

  async function testDraft() {
    setBusy(true);
    try {
      await rpc.skills.updateDraft({ skillId: block.skillId, name, playbook });
      await rpc.skills.testRun({ skillId: block.skillId });
      await onRefresh();
    } finally {
      setBusy(false);
    }
  }

  const skillName = name || block.name || block.goal.slice(0, 80);

  return (
    <>
      <div
        data-testid="skill-draft-card"
        className="flex w-[min(520px,92%)] min-w-[min(420px,100%)] items-center gap-3 rounded-2xl border border-border bg-card py-3 ps-4 pe-3"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[15px] font-medium text-foreground">{skillName}</span>
            <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[12px] font-medium text-muted-foreground">
              {saved ? <Trans>Saved</Trans> : <Trans>Draft</Trans>}
            </span>
          </div>
          {block.goal.startsWith(skillName.replace(/…$/, "")) ? null : (
            <div className="mt-0.5 truncate text-[13.5px] text-muted-foreground">{block.goal}</div>
          )}
        </div>
        {saved ? null : (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void discardDraft()}>
            <Trans>Discard</Trans>
          </Button>
        )}
        <Button size="sm" variant={saved ? "outline" : "default"} onClick={() => setOpen(true)}>
          <Trans>Review</Trans>
        </Button>
      </div>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="flex w-full flex-col gap-0 data-[side=right]:sm:inset-y-3 data-[side=right]:sm:right-3 data-[side=right]:sm:h-auto data-[side=right]:sm:max-w-[520px] data-[side=right]:sm:rounded-3xl data-[side=right]:sm:border data-[side=right]:sm:border-border data-[side=right]:sm:shadow-float">
          <SheetHeader className="px-6 pt-6 pb-2">
            <SheetTitle className="text-[22px] font-semibold tracking-[-0.01em] text-foreground">
              <Trans>Skill</Trans>
            </SheetTitle>
            <SheetDescription className="truncate">{block.goal}</SheetDescription>
          </SheetHeader>
          <div className="rk-scroll flex flex-1 flex-col overflow-y-auto px-6 pb-4">
            {fieldLabel("skill-draft-name", <Trans>Name</Trans>)}
            <Input
              id="skill-draft-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            {fieldLabel("skill-draft-when", <Trans>When to use</Trans>)}
            <Textarea
              id="skill-draft-when"
              placeholder={t`When should this run?`}
              value={playbook.whenToUse}
              onChange={(event) => setPlaybook({ ...playbook, whenToUse: event.target.value })}
              rows={2}
            />
            {fieldLabel("skill-draft-inputs", <Trans>Inputs</Trans>)}
            <Textarea
              id="skill-draft-inputs"
              placeholder={t`What do you give me each time?`}
              value={playbook.inputs.join("\n")}
              onChange={(event) =>
                setPlaybook({
                  ...playbook,
                  inputs: event.target.value.split("\n"),
                })
              }
              rows={2}
            />
            {fieldLabel("skill-draft-steps", <Trans>Steps</Trans>)}
            <Textarea
              id="skill-draft-steps"
              placeholder={t`One step per line`}
              value={playbook.steps.join("\n")}
              onChange={(event) =>
                setPlaybook({
                  ...playbook,
                  steps: event.target.value.split("\n"),
                })
              }
              rows={5}
            />
            {fieldLabel("skill-draft-check", <Trans>How to check</Trans>)}
            <Textarea
              id="skill-draft-check"
              placeholder={t`How will we know it worked?`}
              value={playbook.howToCheck}
              onChange={(event) => setPlaybook({ ...playbook, howToCheck: event.target.value })}
              rows={2}
            />
            {fieldLabel("skill-draft-return", <Trans>What to return</Trans>)}
            <Textarea
              id="skill-draft-return"
              placeholder={t`What do you want back?`}
              value={playbook.whatToReturn}
              onChange={(event) => setPlaybook({ ...playbook, whatToReturn: event.target.value })}
              rows={2}
            />
            {fieldLabel("skill-draft-approval", <Trans>Approval boundaries</Trans>)}
            <Textarea
              id="skill-draft-approval"
              placeholder={t`What should I ask you about first?`}
              value={playbook.approvalBoundaries}
              onChange={(event) =>
                setPlaybook({ ...playbook, approvalBoundaries: event.target.value })
              }
              rows={2}
            />
            {fieldLabel("skill-draft-failure", <Trans>Failure handling</Trans>)}
            <Textarea
              id="skill-draft-failure"
              placeholder={t`What should I do if it goes wrong?`}
              value={playbook.failureHandling}
              onChange={(event) =>
                setPlaybook({ ...playbook, failureHandling: event.target.value })
              }
              rows={2}
            />
          </div>
          <div className="flex flex-wrap gap-2 border-t border-border px-6 py-4">
            <Button disabled={busy} onClick={() => void saveDraft()}>
              {saved ? <Trans>Saved</Trans> : busy ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => void testDraft()}>
              <Trans>Test</Trans>
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => onAddRoutine(skillName, formatSkillRunPrompt(skillName, playbook))}
            >
              <Trans>Add to routine</Trans>
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
