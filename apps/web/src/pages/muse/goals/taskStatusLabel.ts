import type { GoalTaskStatus } from "@aiden/contracts";
import { t } from "@lingui/core/macro";

/** A Task status's short label — used as the sr-only text next to its `PlanNode` marker. */
export function goalTaskStatusLabel(status: GoalTaskStatus): string {
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
