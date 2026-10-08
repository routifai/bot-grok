import { Trans } from "@lingui/react/macro";
import type { SkillPlaybook } from "@nova/contracts";
import { Button } from "@nova/ui-web";
import { useState } from "react";
import { rpc } from "../../lib/rpc";
import { SkillReviewSheet, useTaughtSkill } from "./SkillReviewSheet";

type SkillDraftBlock = {
  kind: "skill_draft";
  skillId: string;
  name: string;
  goal: string;
  playbook: SkillPlaybook;
  status: "draft" | "saved";
};

/** The card left in the Conversation when teaching stops; Review opens the engine's draft. */
export function SkillDraftCard({
  block,
  onRefresh,
  onAddRoutine,
}: {
  block: SkillDraftBlock;
  onRefresh: () => Promise<void>;
  onAddRoutine: (name: string, prompt: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // The card shows the draft's state as the engine has it: it fills in while the teacher writes.
  const { skill, gone, reload } = useTaughtSkill(block.skillId);
  const status = skill?.status ?? block.status;
  const skillName = skill?.name || block.name || block.goal.slice(0, 80);
  const writing = status === "drafting" || status === "recording";

  async function discardDraft() {
    setBusy(true);
    try {
      await rpc.skills.remove({ skillId: block.skillId });
      await onRefresh();
    } finally {
      setBusy(false);
    }
  }

  if (gone) {
    return (
      <p data-testid="skill-draft-legacy" className="text-[13.5px] text-muted-foreground">
        <Trans>This draft is from an earlier version</Trans>
      </p>
    );
  }

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
              {status === "saved" ? (
                <Trans>Saved</Trans>
              ) : writing ? (
                <Trans>Writing…</Trans>
              ) : status === "failed" ? (
                <Trans>Failed</Trans>
              ) : (
                <Trans>Draft</Trans>
              )}
            </span>
          </div>
          {block.goal.startsWith(skillName.replace(/…$/, "")) ? null : (
            <div className="mt-0.5 truncate text-[13.5px] text-muted-foreground">{block.goal}</div>
          )}
        </div>
        {status === "saved" ? null : (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void discardDraft()}>
            <Trans>Discard</Trans>
          </Button>
        )}
        <Button
          size="sm"
          variant={status === "saved" ? "outline" : "default"}
          disabled={status === "failed"}
          onClick={() => setOpen(true)}
        >
          <Trans>Review</Trans>
        </Button>
      </div>
      <SkillReviewSheet
        skillId={block.skillId}
        open={open}
        onOpenChange={setOpen}
        onAddRoutine={onAddRoutine}
        onChanged={async () => {
          await reload();
          await onRefresh();
        }}
      />
    </>
  );
}
