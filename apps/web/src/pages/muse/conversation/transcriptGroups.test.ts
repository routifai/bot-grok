import type { ThreadMessage } from "@nova/contracts";
import { expect, it } from "vitest";
import type { TranscriptRow } from "./failureNotes";
import { foldGroupRuns } from "./transcriptGroups";

const message = (id: string) => ({ id, role: "bot", blocks: [] }) as unknown as ThreadMessage;
const rows = (...ids: string[]): TranscriptRow[] =>
  ids.map((id) => ({ kind: "message", message: message(id) }));
const ids = (folded: TranscriptRow[]) =>
  folded.map((row) => (row.kind === "message" ? row.message.id : row.messages.map((m) => m.id)));

const charts = { joins: (m: ThreadMessage) => m.id.startsWith("chart"), render: () => null };

it("folds each run of joined messages into one group, a lone one included", () => {
  const folded = foldGroupRuns(
    rows("ask", "chart1", "chart2", "chart3", "reply", "chart4"),
    charts,
  );
  expect(ids(folded)).toEqual(["ask", ["chart1", "chart2", "chart3"], "reply", ["chart4"]]);
  expect(folded[1]?.kind).toBe("group");
});

it("leaves the rows alone without a group", () => {
  expect(ids(foldGroupRuns(rows("a", "chart1"), null))).toEqual(["a", "chart1"]);
});
