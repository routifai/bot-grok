import type { ThreadMessage } from "@aiden/contracts";
import type { ReactNode } from "react";
import { MuseLiveStatus } from "./MuseLiveStatus";
import type { MuseLiveRun } from "./useMuseLiveState";

/**
 * The Conversation's floating chrome (docs/muse/DESIGN.md "Conversation" / "Status"): no
 * title bar and no border. It floats over the transcript, which fades out beneath it.
 * The live Muse indicator sits in the center (nothing while idle), and quiet round
 * controls (the context panel, the computer) sit on the right.
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
    <div className="app-drag pointer-events-none absolute inset-x-0 top-0 z-10 flex h-16 items-center justify-center px-4 md:px-6">
      <div className="app-no-drag pointer-events-auto">
        <MuseLiveStatus
          botId={botId}
          color={color}
          runs={runs}
          messages={messages}
          onOpenWaiting={onOpenWaiting}
        />
      </div>
      {actions ? (
        <div className="app-no-drag pointer-events-auto absolute inset-y-0 end-4 flex items-center gap-1.5 md:end-6">
          {actions}
        </div>
      ) : null}
    </div>
  );
}
