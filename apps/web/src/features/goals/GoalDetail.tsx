import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@nova/chat-ui/web";
import type { Goal } from "@nova/contracts";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@nova/ui-web";
import { ChevronLeft, MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { rpc } from "../../lib/rpc";
import { MUSE_TYPE, MuseColumn, Section } from "../../pages/muse/ui";
import { CheckInEditor } from "./CheckInEditor";
import { dueMeta, goalDisplayStatus, taskCounts } from "./format";
import { GoalLog } from "./GoalLog";
import { GoalProposalCard } from "./GoalProposalCard";
import { GoalRing, GoalStep, stepStateOf } from "./visuals";

export function GoalDetail({
  goal,
  onBack,
  onChanged,
  onPlanIt,
}: {
  goal: Goal;
  onBack: () => void;
  onChanged: (updated: Goal) => void;
  /** Asks the Muse, in the Conversation, to propose a plan for this Goal. */
  onPlanIt?: (goal: Goal) => void;
}) {
  const { t, i18n } = useLingui();
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [checkInSaving, setCheckInSaving] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const orderedTasks = [...goal.tasks].sort((a, b) => a.idx - b.idx);
  const due = dueMeta(goal.due, i18n.locale);
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
    const updated = await rpc.goals.acceptProposal({
      goalId: goal.id,
      proposalId: goal.openProposal.id,
    });
    onChanged(updated);
  }

  async function dismissProposal() {
    if (!goal.openProposal) return;
    const updated = await rpc.goals.dismissProposal({
      goalId: goal.id,
      proposalId: goal.openProposal.id,
    });
    onChanged(updated);
  }

  const { done, total } = taskCounts(goal);
  const status = goalDisplayStatus(goal);
  const statusLine =
    status === "waiting"
      ? goal.openProposal
        ? t`Plan waiting for you`
        : t`Needs you`
      : status === "paused"
        ? t`Paused`
        : status === "working"
          ? t`Working on it`
          : status === "noPlan"
            ? t`No plan yet`
            : t`On track`;

  return (
    <MuseColumn data-testid="goal-detail" className="pb-16">
      <div className="flex items-center justify-between pt-8">
        <Button
          variant="ghost"
          size="sm"
          className="-ms-2 gap-1 rounded-full text-muted-foreground"
          onClick={onBack}
        >
          <ChevronLeft size={16} strokeWidth={2} />
          <Trans>Goals</Trans>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="rounded-full text-muted-foreground"
                aria-label={t`Goal options`}
                disabled={statusBusy}
              />
            }
          >
            <MoreHorizontal size={18} strokeWidth={2} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            {goal.status === "active" ? (
              <DropdownMenuItem onClick={() => void setStatus("paused")}>
                <Trans>Pause</Trans>
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onClick={() => void setStatus("active")}>
                <Trans>Resume</Trans>
              </DropdownMenuItem>
            )}
            <DropdownMenuItem variant="destructive" onClick={() => setCancelOpen(true)}>
              <Trans>Cancel Goal</Trans>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="mt-5 flex items-center gap-5">
        <GoalRing value={total > 0 ? done / total : 0} toneClass="stroke-sig-goals" size="lg" />
        <div className="min-w-0 flex-1">
          <h1 className={MUSE_TYPE.pageTitle} dir="auto">
            {goal.title}
          </h1>
          <p className="mt-1 text-[14.5px] text-muted-foreground">
            <span className={status === "waiting" ? "font-medium text-warning" : undefined}>
              {statusLine}
            </span>
            {total > 0 ? <> · {t`${done} of ${total} done`}</> : null}
            {dueLine ? <> · {dueLine}</> : null}
          </p>
        </div>
      </div>

      {goal.description ? (
        <div className="mt-5 text-[15px] leading-[1.6] text-muted-foreground">
          <ChatMarkdown>{goal.description}</ChatMarkdown>
        </div>
      ) : null}
      {statusError ? <p className="mt-3 text-[13px] text-destructive">{statusError}</p> : null}

      {status === "noPlan" && onPlanIt ? (
        <Button
          variant="secondary"
          size="sm"
          className="mt-5 rounded-full px-4"
          onClick={() => onPlanIt(goal)}
        >
          <Trans>Plan it</Trans>
        </Button>
      ) : null}

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

      {orderedTasks.length > 0 ? (
        <Section title={<Trans>Plan</Trans>} className="mt-10">
          <ul data-testid="goal-task-list" className="nova-card px-5 py-3">
            {orderedTasks.map((task) => (
              <GoalStep
                key={task.id}
                state={stepStateOf(task.status)}
                status={task.status}
                note={task.note}
              >
                {task.title}
              </GoalStep>
            ))}
          </ul>
        </Section>
      ) : null}

      {goal.checkInCrons.length > 0 ? (
        <Section title={<Trans>Check-ins</Trans>} className="mt-10">
          <CheckInEditor
            key={goal.id}
            crons={goal.checkInCrons}
            timezone={goal.timezone}
            saving={checkInSaving}
            onSave={saveCheckIn}
          />
        </Section>
      ) : null}

      <Section title={<Trans>What I've done</Trans>} className="mt-10">
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
