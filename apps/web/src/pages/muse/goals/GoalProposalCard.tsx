import { ChatMarkdown } from "@aiden/chat-ui/web";
import type { GoalProposal, GoalTask } from "@aiden/contracts";
import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { SparkGlyph } from "../chrome/NovaGlyphs";
import { NovaTile } from "../chrome/NovaTile";
import { PRIMARY_BUTTON, QUIET_BUTTON } from "../ui";

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

  const first = currentTasks.length === 0;
  return (
    <section data-testid="goal-proposal-card" className="nova-card p-4">
      <div className="flex items-center gap-2.5">
        <NovaTile tone="orange" size={28}>
          <SparkGlyph />
        </NovaTile>
        <h2 className="text-[15px] font-semibold tracking-[-0.2px] text-foreground">
          {first ? <Trans>Here's my plan</Trans> : <Trans>I'd like to change the plan</Trans>}
        </h2>
      </div>
      {!first && proposal.reason ? (
        <div className="mt-1 text-[14.5px] leading-[1.5] text-muted-foreground">
          <ChatMarkdown>{proposal.reason}</ChatMarkdown>
        </div>
      ) : null}
      <ol className="mt-3 flex flex-col gap-2">
        {next.map((item, index) => (
          <li key={`${index}-${item.title}`} className="flex gap-3 text-[15px] leading-[1.45]">
            <span className="w-4 shrink-0 text-end tabular-nums text-muted-foreground">
              {index + 1}
            </span>
            <span className="min-w-0 flex-1 text-foreground" dir="auto">
              {item.title}
              {item.added && !first ? (
                <span className="ms-2 text-[12.5px] font-medium text-ok">
                  <Trans>New</Trans>
                </span>
              ) : null}
            </span>
          </li>
        ))}
        {removed.map((title, index) => (
          <li
            key={`removed-${index}-${title}`}
            className="flex gap-3 text-[14.5px] text-muted-foreground"
          >
            <span className="w-4 shrink-0" />
            <span className="min-w-0 flex-1 line-through" dir="auto">
              <span className="sr-only">{t`Removed: `}</span>
              {title}
            </span>
          </li>
        ))}
      </ol>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <button
          type="button"
          className={QUIET_BUTTON}
          disabled={pending !== null}
          onClick={() => void run("dismiss")}
        >
          {first ? <Trans>Not now</Trans> : <Trans>Keep current</Trans>}
        </button>
        <button
          type="button"
          className={PRIMARY_BUTTON}
          disabled={pending !== null}
          onClick={() => void run("accept")}
        >
          {pending === "accept" ? (
            <Trans>Starting…</Trans>
          ) : first ? (
            <Trans>Start this plan</Trans>
          ) : (
            <Trans>Use the new plan</Trans>
          )}
        </button>
      </div>
      {error ? <p className="mt-3 text-[13px] text-destructive">{error}</p> : null}
    </section>
  );
}
