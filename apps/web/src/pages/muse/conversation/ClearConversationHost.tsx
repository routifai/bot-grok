import type { Bot, Group } from "@aiden/contracts";
import { rpc } from "../../../lib/rpc";
import { ClearConversationDialog } from "../../shell/dialogs";
import type { useThreadState } from "./useThreadState";
import type { useThreadSync } from "./useThreadSync";

export type ClearTarget = { kind: "bot"; chat: Bot } | { kind: "group"; chat: Group };

/** Confirms and performs clearing a conversation's history. */
export function ClearConversationHost({
  clearTarget,
  onClose,
  active,
  activeGroup,
  resetThreadHistory,
  updateSnapshot,
  refreshBots,
}: {
  clearTarget: ClearTarget;
  onClose: () => void;
  active: Bot | undefined;
  activeGroup: Group | undefined;
  resetThreadHistory: ReturnType<typeof useThreadSync>["resetThreadHistory"];
  updateSnapshot: ReturnType<typeof useThreadState>["updateSnapshot"];
  refreshBots: () => Promise<void>;
}) {
  return (
    <ClearConversationDialog
      bot={clearTarget.chat}
      onCancel={() => onClose()}
      onConfirm={async () => {
        await rpc.threads.clear(
          clearTarget.kind === "bot"
            ? { botId: clearTarget.chat.id }
            : { groupId: clearTarget.chat.id },
        );
        if (
          (clearTarget.kind === "bot" && active?.id === clearTarget.chat.id) ||
          (clearTarget.kind === "group" && activeGroup?.id === clearTarget.chat.id)
        ) {
          resetThreadHistory();
          updateSnapshot((current) =>
            current ? { ...current, messages: [], olderCursor: null, run: null } : current,
          );
        }
        onClose();
        await refreshBots();
      }}
    />
  );
}
