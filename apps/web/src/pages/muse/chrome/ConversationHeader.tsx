import { Trans, useLingui } from "@lingui/react/macro";
import type { Goal } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { rpc } from "../../../lib/rpc";
import { useAsks } from "../asks";
import { StatusPill } from "../ui";
import { deriveStatusPill } from "./statusPill";

/**
 * The Conversation header (docs/muse/DESIGN.md "Conversation" / "Status"): the
 * Muse's name and face, a `StatusPill` deriving what it's on right now, and
 * whatever quiet header controls the shell still needs (the computer toggle).
 */
export function ConversationHeader({
  botId,
  museName,
  running,
  actions,
  onOpenWaiting,
}: {
  botId: string;
  museName: string;
  running: boolean;
  actions?: ReactNode;
  onOpenWaiting?: () => void;
}) {
  const { t } = useLingui();
  const [goals, setGoals] = useState<Goal[]>([]);
  const generation = useRef(0);
  const { asks, count: askCount } = useAsks(botId);
  // Cycle through what's waiting so the pill says what Aiden actually needs.
  const [askIndex, setAskIndex] = useState(0);
  useEffect(() => {
    setAskIndex(0);
    if (asks.length < 2) return;
    const timer = window.setInterval(() => setAskIndex((index) => (index + 1) % asks.length), 4000);
    return () => window.clearInterval(timer);
  }, [asks.length]);
  const currentAsk = asks[askIndex % Math.max(asks.length, 1)];

  useEffect(() => {
    const current = ++generation.current;
    void rpc.goals
      .list({ botId })
      .then((list) => {
        if (current === generation.current) setGoals(list);
      })
      .catch(() => {
        if (current === generation.current) setGoals([]);
      });
    return () => {
      generation.current += 1;
    };
  }, [botId]);

  const pill = deriveStatusPill({ museName, goals, running, openAskCount: askCount });

  return (
    <div className="app-drag flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-4 md:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <span className="truncate text-[15.5px] font-semibold text-foreground">
          <Trans>Conversation</Trans>
        </span>
        {pill.tone === "attention" && currentAsk ? (
          <StatusPill
            tone="attention"
            onClick={onOpenWaiting}
            label={t`Open what's waiting on you`}
            className="max-w-[min(560px,60vw)]"
          >
            <span className="shrink-0">{t`${museName} needs you`}</span>
            <span aria-hidden="true" className="text-muted-foreground">
              ·
            </span>
            <span
              key={currentAsk.id}
              className="min-w-0 truncate font-normal text-muted-foreground animate-in fade-in slide-in-from-bottom-1 duration-300"
            >
              {currentAsk.text}
            </span>
            {askCount > 1 ? (
              <span className="shrink-0 rounded-full bg-warning/15 px-1.5 text-[11.5px] tabular-nums text-warning">
                {askIndex + 1}/{askCount}
              </span>
            ) : null}
          </StatusPill>
        ) : (
          <StatusPill tone={pill.tone}>{pill.text}</StatusPill>
        )}
      </div>
      {actions ? (
        <div className="app-no-drag flex shrink-0 items-center gap-1">{actions}</div>
      ) : null}
    </div>
  );
}
