import { useLingui } from "@lingui/react/macro";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@rakazo/ui-web";
import { AskItem, useAsks } from "./asks";

/**
 * "Waiting on you" (docs/muse/PLAN.md, F4): every open Ask, newest first,
 * answerable in place. Opened from the Muse avatar's badge; the badge's count
 * and this list share `useAsks` so answering here (or in the Conversation, or
 * in a Goal log) closes the Ask everywhere at once (CONTEXT.md, "Ask").
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
  const { asks, answer } = useAsks(botId);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{t`Waiting on you`}</SheetTitle>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-4 pb-6">
          {asks.length === 0 ? (
            <p className="mt-1 text-[13.5px] text-muted-foreground">{t`Nothing waiting on you.`}</p>
          ) : (
            <div className="flex flex-col gap-3">
              {asks.map((ask) => (
                <AskItem
                  key={ask.id}
                  ask={ask}
                  onAnswer={(value) => answer({ askId: ask.id, runId: ask.runId, answer: value })}
                />
              ))}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
