import { t } from "@lingui/core/macro";
import type { GoalTaskStatus } from "@rakazo/contracts";
import { Ban, Check, CircleDashed, Play, SkipForward } from "lucide-react";

function goalTaskStatusLabel(status: GoalTaskStatus): string {
  switch (status) {
    case "pending":
      return t`Pending`;
    case "in_progress":
      return t`In progress`;
    case "done":
      return t`Done`;
    case "blocked":
      return t`Blocked`;
    case "skipped":
      return t`Skipped`;
    default:
      return status;
  }
}

function goalTaskStatusClassName(status: GoalTaskStatus): string {
  switch (status) {
    case "done":
      return "text-success";
    case "blocked":
      return "text-warning";
    default:
      return "text-muted-foreground";
  }
}

function goalTaskStatusIcon(status: GoalTaskStatus) {
  switch (status) {
    case "done":
      return Check;
    case "blocked":
      return Ban;
    case "in_progress":
      return Play;
    case "skipped":
      return SkipForward;
    default:
      return CircleDashed;
  }
}

/** A Task's status as an icon plus a short label — never color alone. */
export function GoalTaskStatusTag({ status }: { status: GoalTaskStatus }) {
  const Icon = goalTaskStatusIcon(status);
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 text-[12px] font-medium ${goalTaskStatusClassName(status)}`}
    >
      <Icon size={13} strokeWidth={2.2} aria-hidden />
      {goalTaskStatusLabel(status)}
    </span>
  );
}
