import type { Bot, Group } from "@aiden/contracts";
import { useLingui } from "@lingui/react/macro";
import { ORPCError } from "@orpc/client";
import { rpc } from "../../../lib/rpc";
import { ClearConversationDialog } from "../../shell/dialogs";
import type { useThreadState } from "./useThreadState";
import type { useThreadSync } from "./useThreadSync";

export type ClearTarget = { kind: "bot"; chat: Bot } | { kind: "group"; chat: Group };

/** Confirms and performs clearing a conversation's history. The Muse's Conversation is cleared
 * on the engine (every client then refetches on `chat.reset`); it refuses while Nova is
 * working. */
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
  const { t } = useLingui();
  return (
    <ClearConversationDialog
      bot={clearTarget.chat}
      onCancel={() => onClose()}
      onConfirm={async () => {
        if (clearTarget.kind === "bot") {
          try {
            await rpc.chats.reset({ botId: clearTarget.chat.id });
          } catch (error) {
            if (error instanceof ORPCError && error.code === "CONFLICT") {
              throw new Error(t`Wait for Nova to finish, then clear.`);
            }
            throw error;
          }
        }
        // Also drops the cards and notices Nova itself wrote into the thread; the Conversation is
        // already cleared, so this must not fail the action.
        const clearThread = rpc.threads.clear(
          clearTarget.kind === "bot"
            ? { botId: clearTarget.chat.id }
            : { groupId: clearTarget.chat.id },
        );
        if (clearTarget.kind === "bot") await clearThread.catch(() => undefined);
        else await clearThread;
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
