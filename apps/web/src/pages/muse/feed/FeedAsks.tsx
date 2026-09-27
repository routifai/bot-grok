import type { Ask } from "@rakazo/contracts";
import { AskItem } from "../asks";

// Open Asks pinned on top of the Feed. Same AskItem as the Waiting-on-you sheet, so an
// Ask looks and answers the same everywhere (CONTEXT.md: answering anywhere closes it everywhere).
export function FeedAsks({
  asks,
  onAnswer,
}: {
  asks: Ask[];
  onAnswer: (ask: Ask, answer: string) => Promise<void>;
}) {
  if (asks.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      {asks.map((ask) => (
        <AskItem key={ask.id} ask={ask} onAnswer={(value) => onAnswer(ask, value)} />
      ))}
    </div>
  );
}
