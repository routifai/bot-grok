import type { ThreadMessage } from "@nova/contracts";
import { createContext, type ReactNode, useContext } from "react";
import type { TranscriptRow } from "./failureNotes";

/**
 * Messages a capability draws as one set when they come in a row (the charts of a dashboard
 * reply). The shell provides it, so the transcript stays free of capability imports.
 */
export interface TranscriptGroup {
  joins(message: ThreadMessage): boolean;
  render(messages: readonly ThreadMessage[]): ReactNode;
}

const TranscriptGroupContext = createContext<TranscriptGroup | null>(null);
export const TranscriptGroupProvider = TranscriptGroupContext.Provider;
export const useTranscriptGroup = () => useContext(TranscriptGroupContext);

/** The rows with every run of messages the group joins (one or more) folded into one `group` row. */
export function foldGroupRuns(
  rows: TranscriptRow[],
  group: TranscriptGroup | null,
): TranscriptRow[] {
  if (!group) return rows;
  const folded: TranscriptRow[] = [];
  for (const row of rows) {
    if (row.kind === "message" && group.joins(row.message)) {
      const last = folded.at(-1);
      if (last?.kind === "group") last.messages.push(row.message);
      else folded.push({ kind: "group", messages: [row.message] });
      continue;
    }
    folded.push(row);
  }
  return folded;
}
