import type { Ask } from "@aiden/contracts";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@aiden/ui-web";
import { useLingui } from "@lingui/react/macro";
import { AskList, useAsks } from "./asks";
import { CardSkeletonList } from "./feed/CardSkeleton";
import { EmptyState } from "./ui";

/**
 * "Waiting on you" (docs/muse/PLAN.md, F4): every open Ask, newest first, as a plain
 * list with hairline dividers — answerable in place. Opened from the Muse avatar's
 * badge; the badge's count and this list share `useAsks` so answering here (or in the
 * Conversation, or in a Goal log) closes the Ask everywhere at once (CONTEXT.md, "Ask").
 */
export function WaitingSheet({
  botId,
  avatarColor,
  open,
  onOpenChange,
}: {
  botId: string;
  avatarColor?: string;
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
      <SheetContent className="flex w-full flex-col gap-0 data-[side=right]:sm:inset-y-3 data-[side=right]:sm:right-3 data-[side=right]:sm:h-auto data-[side=right]:sm:max-w-[440px] data-[side=right]:sm:rounded-3xl data-[side=right]:sm:border data-[side=right]:sm:border-border data-[side=right]:sm:shadow-float">
        <SheetHeader className="flex-row items-center gap-2.5 px-6 pt-6 pb-2">
          <SheetTitle className="text-[22px] font-semibold tracking-[-0.01em] text-foreground">
            {t`Waiting on you`}
          </SheetTitle>
          {asks.length > 0 ? (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[13px] font-medium text-muted-foreground tabular-nums">
              {asks.length}
            </span>
          ) : null}
        </SheetHeader>
        <div
          data-fade-top=""
          className="rk-scroll flex flex-1 flex-col overflow-y-auto px-6 pt-3 pb-6"
        >
          {asks.length === 0 && loading ? (
            <CardSkeletonList count={2} />
          ) : asks.length === 0 ? (
            <EmptyState
              face
              illustration="bell"
              avatarColor={avatarColor}
              headline={t`You're all caught up`}
            >
              {t`When I need a decision or an answer, it'll show up here.`}
            </EmptyState>
          ) : (
            <AskList asks={asks} onAnswer={handleAnswer} />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
