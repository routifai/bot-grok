import type { Ask } from "@aiden/contracts";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@aiden/ui-web";
import { useLingui } from "@lingui/react/macro";
import { AskList, useAsks } from "./asks";
import { CardSkeletonList } from "./feed/CardSkeleton";
import { EmptyState, MUSE_TYPE } from "./ui";

/**
 * "Waiting on you" (docs/muse/PLAN.md, F4): every open Ask, newest first, as a plain
 * list with hairline dividers — answerable in place. Opened from the Muse avatar's
 * badge; the badge's count and this list share `useAsks` so answering here (or in the
 * Conversation, or in a Goal log) closes the Ask everywhere at once (CONTEXT.md, "Ask").
 */
export function WaitingSheet({
  botId,
  open,
  onOpenChange,
}: {
  botId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useLingui();
  const { asks, loading, answer } = useAsks(botId);

  async function handleAnswer(ask: Ask, value: string) {
    await answer({ askId: ask.id, runId: ask.runId, answer: value });
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-md">
        <SheetHeader className="gap-1 border-b border-border px-6 py-5">
          <SheetTitle className={`flex items-baseline gap-2 ${MUSE_TYPE.pageTitle}`}>
            {t`Waiting on you`}
            {asks.length > 0 ? (
              <span className="font-sans text-[14px] font-normal text-muted-foreground">
                {asks.length}
              </span>
            ) : null}
          </SheetTitle>
        </SheetHeader>
        <div className="rk-scroll flex-1 overflow-y-auto px-6 py-5">
          {asks.length === 0 && loading ? (
            <CardSkeletonList count={2} />
          ) : asks.length === 0 ? (
            <EmptyState
              headline={t`You're all caught up.`}
            >{t`Nothing waiting on you.`}</EmptyState>
          ) : (
            <AskList asks={asks} onAnswer={handleAnswer} />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
