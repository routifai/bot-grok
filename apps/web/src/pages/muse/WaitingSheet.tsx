import { useLingui } from "@lingui/react/macro";
import type { Ask } from "@nova/contracts";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@nova/ui-web";
import { Check, Minus } from "lucide-react";
import { useState } from "react";
import { AskList, useAsks } from "./asks";
import { WaitingGlyph } from "./chrome/NovaGlyphs";
import { NovaTile } from "./chrome/NovaTile";
import { CardSkeletonList } from "./feed/CardSkeleton";
import { EmptyState, MUSE_INSET_GROUP, MUSE_LIST_ROW, MUSE_TYPE } from "./ui";

/** An Ask answered from this sheet, kept for the "Decided" list while the app is open. */
type Decided = { ask: Ask; label: string; primary: boolean; at: Date };

/**
 * "Waiting on you" (docs/muse/DESIGN.md "Waiting on you"): every open Ask, newest first, as
 * big decision cards answerable in place, then what was decided here this session. Opened
 * from the sidebar; the badge's count and this list share `useAsks`, so answering here (or in
 * the Conversation, or in a Goal log) closes the Ask everywhere at once (CONTEXT.md, "Ask").
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
  const { t, i18n } = useLingui();
  const { asks, loading, answer } = useAsks(botId);
  const [decided, setDecided] = useState<Decided[]>([]);

  async function handleAnswer(ask: Ask, value: string) {
    await answer({ askId: ask.id, runId: ask.runId, answer: value });
    const index = ask.choices.findIndex((choice) => choice.id === value);
    setDecided((current) => [
      {
        ask,
        label: index >= 0 ? (ask.choices[index]?.label ?? value) : t`Answered`,
        primary: index <= 0,
        at: new Date(),
      },
      ...current,
    ]);
  }

  const approvalTitle = t`One yes before I send this`;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 bg-content data-[side=right]:sm:inset-y-3 data-[side=right]:sm:right-3 data-[side=right]:sm:h-auto data-[side=right]:sm:max-w-[520px] data-[side=right]:sm:rounded-[22px] data-[side=right]:sm:border-0 data-[side=right]:sm:shadow-float">
        <SheetHeader className="shrink-0 flex-row items-center gap-3.5 px-6 pt-6 pb-3">
          <NovaTile tone="orange" size={44}>
            <WaitingGlyph />
          </NovaTile>
          <div className="min-w-0">
            <SheetTitle className={MUSE_TYPE.pageTitle}>{t`Waiting on you`}</SheetTitle>
            <SheetDescription className={MUSE_TYPE.pageSubtitle}>
              {t`I ask before doing anything I can't undo.`}
            </SheetDescription>
          </div>
        </SheetHeader>
        <div
          data-fade-top=""
          className="rk-scroll flex flex-1 flex-col gap-5 overflow-y-auto px-6 pt-3 pb-6"
        >
          <div data-testid="waiting-open">
            {asks.length === 0 && loading ? (
              <CardSkeletonList count={2} />
            ) : asks.length === 0 ? (
              <EmptyState illustration="bell" headline={t`You're all caught up`}>
                {t`When I need a decision or an answer, it'll show up here.`}
              </EmptyState>
            ) : (
              <AskList asks={asks} onAnswer={handleAnswer} />
            )}
          </div>
          {decided.length > 0 ? (
            <section className="flex flex-col gap-1.5" data-testid="waiting-decided">
              <h3 className="px-1.5 text-[13px] font-semibold text-foreground">{t`Decided`}</h3>
              <div className={MUSE_INSET_GROUP}>
                {decided.map((entry) => (
                  <div key={entry.ask.id} className={MUSE_LIST_ROW}>
                    <NovaTile tone={entry.primary ? "green" : "gray"} size={28}>
                      {entry.primary ? <Check strokeWidth={2.6} /> : <Minus strokeWidth={2.6} />}
                    </NovaTile>
                    <span className="min-w-0">
                      <span className="block truncate text-foreground" dir="auto">
                        {entry.ask.kind === "approval" && !entry.ask.approval
                          ? approvalTitle
                          : entry.ask.text}
                      </span>
                      <span className="block text-[12px] text-ink-3">
                        {entry.at.toLocaleTimeString(i18n.locale || "en", {
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </span>
                    </span>
                    <span className="max-w-[140px] truncate text-[13px] text-ink-3">
                      {entry.label}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
