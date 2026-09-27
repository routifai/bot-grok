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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@rakazo/ui-web";
import { ChevronLeft } from "lucide-react";
import { useState } from "react";
import { rpc } from "../../../lib/rpc";
import { CheckInEditor } from "./CheckInEditor";
import { formatDueDate } from "./format";
import { GoalLog } from "./GoalLog";
import { GoalProposalCard } from "./GoalProposalCard";
import { GoalTaskStatusTag } from "./GoalTaskStatusTag";

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
  const due = formatDueDate(goal.due, i18n.locale);

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
    <div className="p-4" data-testid="goal-detail">
      <div className="mb-4 flex items-center gap-2">
        <Button variant="ghost" size="icon-sm" aria-label={t`Back`} onClick={onBack}>
          <ChevronLeft />
        </Button>
        <h1
          className="min-w-0 flex-1 truncate text-[15.5px] font-medium text-foreground"
          dir="auto"
        >
          {goal.title}
        </h1>
        {goal.status === "paused" ? (
          <span className="shrink-0 text-[12px] text-muted-foreground">
            <Trans>Paused</Trans>
          </span>
        ) : null}
      </div>

      <div className="mb-4 flex items-center justify-between gap-3">
        {due ? (
          <span className="text-[13px] text-muted-foreground">
            <Trans>Due {due}</Trans>
          </span>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          {goal.status === "active" ? (
            <Button
              variant="outline"
              size="sm"
              disabled={statusBusy}
              onClick={() => void setStatus("paused")}
            >
              <Trans>Pause</Trans>
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={statusBusy}
              onClick={() => void setStatus("active")}
            >
              <Trans>Resume</Trans>
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={statusBusy}
            onClick={() => setCancelOpen(true)}
          >
            <Trans>Cancel</Trans>
          </Button>
        </div>
      </div>
      {statusError ? <p className="mb-3 text-[13px] text-destructive">{statusError}</p> : null}

      <Tabs defaultValue="plan">
        <TabsList aria-label={t`Goal`}>
          <TabsTrigger value="plan">
            <Trans>Plan</Trans>
          </TabsTrigger>
          <TabsTrigger value="log">
            <Trans>Goal log</Trans>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="plan">
          {goal.description ? (
            <div className="mt-3 text-[14.5px] leading-[1.5] text-foreground/90">
              <ChatMarkdown>{goal.description}</ChatMarkdown>
            </div>
          ) : null}

          {goal.openProposal ? (
            <div className="mt-4">
              <GoalProposalCard
                proposal={goal.openProposal}
                currentTasks={goal.tasks}
                onAccept={acceptProposal}
                onDismiss={dismissProposal}
              />
            </div>
          ) : null}

          <ol className="mt-4 space-y-2.5" data-testid="goal-task-list">
            {orderedTasks.map((task) => (
              <li key={task.id} className="flex flex-col gap-1 rounded-xl border border-border p-3">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-[14.5px] text-foreground" dir="auto">
                    {task.title}
                  </span>
                  <GoalTaskStatusTag status={task.status} />
                </div>
                {task.note ? (
                  <p className="text-[13px] text-muted-foreground" dir="auto">
                    {task.note}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>

          <div className="mt-5">
            <CheckInEditor
              key={goal.id}
              crons={goal.checkInCrons}
              timezone={goal.timezone}
              saving={checkInSaving}
              onSave={saveCheckIn}
            />
          </div>
        </TabsContent>
        <TabsContent value="log">
          <GoalLog goalId={goal.id} />
        </TabsContent>
      </Tabs>

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
    </div>
  );
}
