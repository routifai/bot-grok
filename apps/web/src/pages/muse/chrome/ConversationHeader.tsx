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
  const { count: askCount } = useAsks(botId);

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
        {pill.tone === "attention" && askCount > 0 ? (
          <StatusPill
            tone="attention"
            onClick={onOpenWaiting}
            label={t`Open what's waiting on you`}
          >
            <span>{t`${museName} needs you`}</span>
            <span aria-hidden="true" className="text-muted-foreground">
              ·
            </span>
            <span className="font-normal text-muted-foreground">
              {askCount === 1 ? t`1 thing` : t`${askCount} things`}
            </span>
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
