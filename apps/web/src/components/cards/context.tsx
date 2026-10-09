import type { ThreadMessage } from "@nova/contracts";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import { type ResolvedReplyCard, replyCardKey, resolveReplyCards } from "./thread";

/** How a card talks back: the person's next message, through the thread's own send path. */
const SendContext = createContext<((text: string) => void) | null>(null);
const ThreadContext = createContext<Map<string, ResolvedReplyCard> | null>(null);

export function ReplyCardSendProvider({
  send,
  children,
}: {
  send: (text: string) => void;
  children: ReactNode;
}) {
  return <SendContext.Provider value={send}>{children}</SendContext.Provider>;
}

/** Wrap a transcript once; its cards then update in place and lock once answered. */
export function ReplyCardThreadProvider({
  messages,
  children,
}: {
  messages: readonly ThreadMessage[];
  children: ReactNode;
}) {
  const resolved = useMemo(() => resolveReplyCards(messages), [messages]);
  const latest = useMemo(() => latestSavedFiles(messages), [messages]);
  useEffect(() => publishLatestFiles(latest), [latest]);
  return (
    <ThreadContext.Provider value={resolved}>
      <LatestFilesContext.Provider value={latest}>{children}</LatestFilesContext.Provider>
    </ThreadContext.Provider>
  );
}

export type LatestFile = { version: number; artifactId: string };

/** The newest saved version of each deliverable (by file name) anywhere in the thread. */
const LatestFilesContext = createContext<Map<string, LatestFile> | null>(null);

export function latestSavedFiles(messages: readonly ThreadMessage[]): Map<string, LatestFile> {
  const latest = new Map<string, LatestFile>();
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.kind !== "reply_card" || block.card !== "file" || block.pending) continue;
      const { name, artifactId, version } = block.data as {
        name?: string;
        artifactId?: string;
        version?: number;
      };
      if (!name || !artifactId) continue;
      const current = latest.get(name);
      if (!current || (version ?? 1) >= current.version) {
        latest.set(name, { version: version ?? 1, artifactId });
      }
    }
  }
  return latest;
}

// The artifact panel sits beside the transcript, not inside it, so the thread publishes the same
// "newest saved version" signal the cards use for their "Updated" badge into this small store.
const published = new Map<string, number>();
const listeners = new Set<() => void>();

function publishLatestFiles(latest: Map<string, LatestFile>) {
  let changed = false;
  for (const [name, file] of latest) {
    if (file.version > (published.get(name) ?? 0)) {
      published.set(name, file.version);
      changed = true;
    }
  }
  if (changed) for (const listener of listeners) listener();
}

/** The newest version of a file the transcript has shown; changes when a new one arrives. */
export function useLatestSavedVersion(name: string | undefined): number | undefined {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => (name ? published.get(name) : undefined),
  );
}

export const useLatestSavedFile = (name: string) => useContext(LatestFilesContext)?.get(name);

/** The artifact side panel: the shell owns what is open; cards ask to open or close it. */
export type ArtifactPanelApi = {
  openId: string | null;
  open: (artifactId: string, title?: string) => void;
  close: () => void;
};
const ArtifactPanelContext = createContext<ArtifactPanelApi | null>(null);
export const ArtifactPanelProvider = ArtifactPanelContext.Provider;
export const useArtifactPanel = () => useContext(ArtifactPanelContext);

/** The Muse whose chat this is; cards that talk to the API on the person's behalf need it. */
const BotIdContext = createContext<string | null>(null);

export function ReplyCardBotProvider({
  botId,
  children,
}: {
  botId: string | undefined;
  children: ReactNode;
}) {
  return <BotIdContext.Provider value={botId || null}>{children}</BotIdContext.Provider>;
}

export const useReplyCardBotId = () => useContext(BotIdContext);

export const useReplyCardSend = () => useContext(SendContext);

export function useResolvedReplyCard(
  messageId: string,
  blockIndex: number,
): ResolvedReplyCard | undefined {
  return useContext(ThreadContext)?.get(replyCardKey(messageId, blockIndex));
}
