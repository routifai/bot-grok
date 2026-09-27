import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { GoalProposal, GoalTask } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useState } from "react";
import { Eyebrow, Surface } from "../ui";

type ProposalDiff = {
  next: { title: string; added: boolean }[];
  removed: string[];
};

function proposalDiff(
  currentTasks: Pick<GoalTask, "title">[],
  proposedTasks: { title: string }[],
): ProposalDiff {
  const currentTitles = new Set(currentTasks.map((task) => task.title));
  const proposedTitles = new Set(proposedTasks.map((task) => task.title));
  return {
    next: proposedTasks.map((task) => ({
      title: task.title,
      added: !currentTitles.has(task.title),
    })),
    removed: currentTasks.map((task) => task.title).filter((title) => !proposedTitles.has(title)),
  };
}

/**
 * The Muse's proposed change to a Goal's plan (docs/muse/DESIGN.md "Proposal"): the reason,
 * the revised plan as a numbered list with added items marked and removed items struck
 * through, and Accept plan / Keep current.
 */
export function GoalProposalCard({
  proposal,
  currentTasks,
  onAccept,
  onDismiss,
}: {
  proposal: GoalProposal;
  currentTasks: GoalTask[];
  onAccept: () => Promise<void>;
  onDismiss: () => Promise<void>;
}) {
  const { t } = useLingui();
  const [pending, setPending] = useState<"accept" | "dismiss" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { next, removed } = proposalDiff(currentTasks, proposal.tasks);

  async function run(action: "accept" | "dismiss") {
    if (pending) return;
    setPending(action);
    setError(null);
    try {
      await (action === "accept" ? onAccept() : onDismiss());
    } catch {
      setError(t`Could not save`);
    } finally {
      setPending(null);
    }
  }

  return (
    <Surface tone="attention" data-testid="goal-proposal-card" className="p-5">
      <Eyebrow>
        <Trans>Proposed plan</Trans>
      </Eyebrow>
      <div className="mt-2 text-[15px] leading-[1.5] text-foreground">
        <ChatMarkdown>{proposal.reason}</ChatMarkdown>
      </div>
      <ol className="mt-3 list-decimal space-y-1 pl-5 text-[14px] leading-[1.6] marker:text-muted-foreground/70">
        {next.map((item, index) => (
          <li
            key={index}
            className={item.added ? "text-success marker:text-success" : "text-foreground"}
          >
            {item.added ? <span className="sr-only">{t`Added: `}</span> : null}
            {item.title}
          </li>
        ))}
      </ol>
      {removed.length > 0 ? (
        <ul className="mt-2 space-y-1 pl-5 text-[13.5px] text-muted-foreground">
          {removed.map((title, index) => (
            <li key={index} className="line-through">
              <span className="sr-only">{t`Removed: `}</span>
              {title}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-4 flex gap-2">
        <Button disabled={pending !== null} onClick={() => void run("accept")}>
          {pending === "accept" ? <Trans>Accepting…</Trans> : <Trans>Accept plan</Trans>}
        </Button>
        <Button variant="ghost" disabled={pending !== null} onClick={() => void run("dismiss")}>
          {pending === "dismiss" ? <Trans>Keeping…</Trans> : <Trans>Keep current</Trans>}
        </Button>
      </div>
      {error ? <p className="mt-3 text-[13px] text-destructive">{error}</p> : null}
    </Surface>
  );
}
