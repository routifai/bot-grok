import type { Ask } from "@aiden/contracts";
import { t } from "@lingui/core/macro";
import { AskList } from "../asks";
import { Section } from "../ui";

// Open Asks pinned on top of the Feed, under a "Needs you" heading. Same AskList as the
// Waiting-on-you sheet, so an Ask looks and answers the same everywhere (CONTEXT.md:
// answering anywhere closes it everywhere).
export function FeedAsks({
  asks,
  onAnswer,
}: {
  asks: Ask[];
  onAnswer: (ask: Ask, answer: string) => Promise<void>;
}) {
  if (asks.length === 0) return null;
  return (
    <Section title={t`Needs you`}>
      <AskList asks={asks} onAnswer={onAnswer} />
    </Section>
  );
}
