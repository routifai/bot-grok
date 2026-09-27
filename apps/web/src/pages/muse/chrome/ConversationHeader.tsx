import type { Goal } from "@rakazo/contracts";
import { BotAvatar } from "@rakazo/ui-web";
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
  avatarColor,
  avatarStatus,
  running,
  actions,
}: {
  botId: string;
  museName: string;
  avatarColor: string;
  avatarStatus?: string;
  running: boolean;
  actions?: ReactNode;
}) {
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
    <div className="app-drag flex items-center justify-between border-b border-sidebar-border px-4 py-3.5 md:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <BotAvatar
          color={avatarColor}
          identity={botId}
          status={avatarStatus}
          face="muse"
          size={32}
        />
        <div className="min-w-0">
          <div className="truncate text-[15px] font-semibold text-foreground" dir="auto">
            {museName}
          </div>
          <StatusPill tone={pill.tone} className="mt-1">
            {pill.text}
          </StatusPill>
        </div>
      </div>
      {actions ? (
        <div className="app-no-drag flex shrink-0 items-center gap-1">{actions}</div>
      ) : null}
    </div>
  );
}
