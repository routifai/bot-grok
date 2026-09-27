import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { Goal } from "@rakazo/contracts";
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
} from "@rakazo/ui-web";
import { ChevronLeft } from "lucide-react";
import { useState } from "react";
import { rpc } from "../../../lib/rpc";
import { MuseColumn, Section } from "../ui";
import { CheckInEditor } from "./CheckInEditor";
import { checkInSummary, dueMeta } from "./format";
import { GoalLog } from "./GoalLog";
import { GoalProposalCard } from "./GoalProposalCard";
import { GoalStatusPill } from "./GoalStatusPill";
import { MetaLine } from "./MetaLine";
import { PlanTimeline } from "./PlanTimeline";

export function GoalDetail({
  goal,
  onBack,
  onChanged,
}: {
  goal: Goal;
  onBack: () => void;
  onChanged: (updated: Goal) => void;
}) {
  const { t, i18n } = useLingui();
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [checkInSaving, setCheckInSaving] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const orderedTasks = [...goal.tasks].sort((a, b) => a.idx - b.idx);
  const due = dueMeta(goal.due, i18n.locale);
  const checkIn = checkInSummary(goal.checkInCrons);
  const dueLine = due ? (
    due.kind === "absolute" ? (
      <Trans>Due {due.date}</Trans>
    ) : (
      <Trans>in {due.weeks} weeks</Trans>
    )
  ) : null;

  async function setStatus(status: "active" | "paused" | "cancelled") {
    if (statusBusy) return;
    setStatusBusy(true);
    setStatusError(null);
    try {
      const updated = await rpc.goals.update({ goalId: goal.id, status });
      onChanged(updated);
      if (status === "cancelled") setCancelOpen(false);
    } catch {
      setStatusError(t`Could not update`);
    } finally {
      setStatusBusy(false);
    }
  }

  async function saveCheckIn(checkInCrons: string[]) {
    setCheckInSaving(true);
    try {
      const updated = await rpc.goals.update({ goalId: goal.id, checkInCrons });
      onChanged(updated);
    } finally {
      setCheckInSaving(false);
    }
  }

  async function acceptProposal() {
    if (!goal.openProposal) return;
    const updated = await rpc.goals.acceptProposal({ proposalId: goal.openProposal.id });
    onChanged(updated);
  }

  async function dismissProposal() {
    if (!goal.openProposal) return;
    const updated = await rpc.goals.dismissProposal({ proposalId: goal.openProposal.id });
    onChanged(updated);
  }

  return (
    <MuseColumn data-testid="goal-detail">
      <div className="pt-8">
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 gap-1 text-muted-foreground"
          onClick={onBack}
        >
          <ChevronLeft size={15} strokeWidth={1.75} />
          <Trans>All goals</Trans>
        </Button>
      </div>

      <h1
        className="mt-4 font-display text-[32px] leading-[1.1] tracking-[-0.01em] text-foreground"
        dir="auto"
      >
        {goal.title}
      </h1>

      {goal.description ? (
        <div className="mt-3 text-[14.5px] leading-[1.6] text-muted-foreground">
          <ChatMarkdown>{goal.description}</ChatMarkdown>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <MetaLine items={[dueLine, checkIn]} />
        <GoalStatusPill goal={goal} className="ml-auto" />
      </div>

      <div className="mt-4 flex items-center gap-1.5">
        {goal.status === "active" ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            disabled={statusBusy}
            onClick={() => void setStatus("paused")}
          >
            <Trans>Pause</Trans>
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            disabled={statusBusy}
            onClick={() => void setStatus("active")}
          >
            <Trans>Resume</Trans>
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          disabled={statusBusy}
          onClick={() => setCancelOpen(true)}
        >
          <Trans>Cancel</Trans>
        </Button>
      </div>
      {statusError ? <p className="mt-2 text-[13px] text-destructive">{statusError}</p> : null}

      {goal.openProposal ? (
        <div className="mt-8">
          <GoalProposalCard
            proposal={goal.openProposal}
            currentTasks={goal.tasks}
            onAccept={acceptProposal}
            onDismiss={dismissProposal}
          />
        </div>
      ) : null}

      <Section title={<Trans>Plan</Trans>} className="mt-10">
        <PlanTimeline tasks={orderedTasks} />
      </Section>

      <Section title={<Trans>Check-ins</Trans>} className="mt-10">
        <CheckInEditor
          key={goal.id}
          crons={goal.checkInCrons}
          timezone={goal.timezone}
          saving={checkInSaving}
          onSave={saveCheckIn}
        />
      </Section>

      <Section title={<Trans>Goal log</Trans>} className="mt-10">
        <GoalLog goalId={goal.id} />
      </Section>

      {cancelOpen ? (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open && !statusBusy) setCancelOpen(false);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                <Trans>Cancel "{goal.title}"?</Trans>
              </AlertDialogTitle>
              <AlertDialogDescription>
                <Trans>The Muse stops working on this Goal.</Trans>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={statusBusy}>
                <Trans>Keep it</Trans>
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={statusBusy}
                onClick={() => void setStatus("cancelled")}
              >
                {statusBusy ? <Trans>Cancelling…</Trans> : <Trans>Cancel Goal</Trans>}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </MuseColumn>
  );
}
