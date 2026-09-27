import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { GoalProposal, GoalTask } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useState } from "react";

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
 * The Muse's proposed change to a Goal's plan: the reason, a diff-style view of the
 * revised plan against the current one, and Accept / Dismiss. Matches AskCard's look
 * (AskCard itself doesn't fit this shape — a Proposal isn't a message-block ask).
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
    <div
      data-testid="goal-proposal-card"
      className="max-w-[74%] rounded-2xl border border-border bg-card px-5 py-4"
    >
      <div className="text-[12.5px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
        <Trans>Proposed plan</Trans>
      </div>
      <div className="mt-2 text-[15px] leading-[1.5] text-foreground">
        <ChatMarkdown>{proposal.reason}</ChatMarkdown>
      </div>
      <ol className="mt-3 space-y-1 text-[14px] leading-[1.5]">
        {next.map((item, index) => (
          <li key={index} className={item.added ? "text-success" : "text-foreground"}>
            {item.added ? <span className="sr-only">{t`Added`}</span> : null}
            <span aria-hidden>{item.added ? "+ " : ""}</span>
            {item.title}
          </li>
        ))}
        {removed.map((title, index) => (
          <li key={`removed-${index}`} className="text-muted-foreground line-through">
            <span className="sr-only">{t`Removed`}</span>
            <span aria-hidden>{"- "}</span>
            {title}
          </li>
        ))}
      </ol>
      <div className="mt-3.5 flex gap-2">
        <Button disabled={pending !== null} onClick={() => void run("accept")}>
          {pending === "accept" ? <Trans>Accepting…</Trans> : <Trans>Accept</Trans>}
        </Button>
        <Button variant="outline" disabled={pending !== null} onClick={() => void run("dismiss")}>
          {pending === "dismiss" ? <Trans>Dismissing…</Trans> : <Trans>Dismiss</Trans>}
        </Button>
      </div>
      {error ? <p className="mt-3 text-[13px] text-destructive">{error}</p> : null}
    </div>
  );
}
