import type { ThreadMessage } from "@aiden/contracts";
import { Trans } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { MuseLiveStatus } from "./MuseLiveStatus";
import type { MuseLiveRun } from "./useMuseLiveState";

/**
 * The Conversation header (docs/muse/DESIGN.md "Conversation" / "Status"): a plain
 * title, the live Muse indicator next to it, and whatever quiet header controls the
 * shell still needs (the computer toggle). Idle shows no indicator at all.
 */
export function ConversationHeader({
  botId,
  color,
  runs,
  messages,
  actions,
  onOpenWaiting,
}: {
  botId: string;
  color: string;
  runs: readonly MuseLiveRun[];
  messages: readonly ThreadMessage[] | undefined;
  actions?: ReactNode;
  onOpenWaiting?: () => void;
}) {
  return (
    <div className="app-drag flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-4 md:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <span className="truncate text-[15.5px] font-semibold text-foreground">
          <Trans>Conversation</Trans>
        </span>
        <MuseLiveStatus
          botId={botId}
          color={color}
          runs={runs}
          messages={messages}
          onOpenWaiting={onOpenWaiting}
        />
      </div>
      {actions ? (
        <div className="app-no-drag flex shrink-0 items-center gap-1">{actions}</div>
      ) : null}
    </div>
  );
}
