import type { ChatSummary, ThreadMessage } from "@nova/contracts";
import { cn } from "@nova/ui-web";
import { useCallback, useMemo, useRef, useState } from "react";
import type { ArtifactTarget } from "../../lib/artifact-open";
import { MuseSidebar } from "../muse/chrome/MuseSidebar";
import type { ChatListState } from "../muse/chrome/useChatList";
import { Transcript } from "../muse/conversation/Transcript";
import { AllForks, ForkViewSwitch } from "../muse/forks/AllForks";
import { ForkAsk } from "../muse/forks/ForkAsk";
import { ForkGutter } from "../muse/forks/ForkGutter";
import type { ForkWire } from "../muse/forks/ForkOverlay";
import { ForkThread } from "../muse/forks/ForkThread";
import { useForkView } from "../muse/forks/useForkView";
import {
  conversationWithForks,
  FORK_DEV_CONVERSATION,
  FORK_SEEDS,
  forkChat,
  forkMessages,
} from "./fork-fixture";
import { DEV_BOT_ID, DEV_MUSE_COLOR, DEV_MUSE_NAME, DEV_PERSON_NAME } from "./side-chat-fixture";

const noop = () => undefined;
const noopAsync = async () => undefined;
const delay = <T,>(value: T, ms = 300) =>
  new Promise<T>((resolve) => window.setTimeout(() => resolve(value), ms));

/**
 * Dev-only route (`/dev/forks`, gated by `import.meta.env.DEV` in App.tsx, like
 * `/dev/side-chats`): the real Conversation transcript, fork stubs and pills, gutter, sidebar,
 * thread view, "lift and ask" and All forks, wired to in-memory fixtures instead of `chats.*`.
 * `?fork=<id>` opens a fork's thread straight away; `?view=forks` the All forks list.
 */
export function ForksPreviewPage() {
  const [seeds, setSeeds] = useState(FORK_SEEDS);
  const replies = useRef(new Map(FORK_SEEDS.map((seed) => [seed.id, forkMessages(seed)])));
  const nextId = useRef(1);
  const messages = useMemo(() => conversationWithForks(seeds), [seeds]);
  const chatList = useMemo<ChatListState>(
    () => ({ status: "ready", chats: seeds.map(forkChat) }),
    [seeds],
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollRequest, setScrollRequest] = useState<{ messageId: string; nonce: number } | null>(
    null,
  );
  const scrollToMessage = useCallback(
    (messageId: string) => setScrollRequest({ messageId, nonce: Date.now() }),
    [],
  );
  const forks = useForkView({
    chatList,
    messages,
    scrollRef,
    reveal: async (id) => messages.some((message) => message.id === id),
    scrollToMessage,
  });

  const wire = useMemo<ForkWire>(
    () => ({
      summaryPreview: () => delay({ summary: "" }),
      createSide: (input) =>
        delay({
          id: `side-dev-${nextId.current++}`,
          title: input.text,
          start: input.start,
          summary: null,
          archived: false,
          live: false,
          updatedAt: new Date().toISOString(),
        }),
      transcript: (input) =>
        delay({
          threadId: input.chatId,
          messages: replies.current.get(input.chatId) ?? [],
          olderCursor: null,
          running: false,
          lineage: {
            rootId: FORK_DEV_CONVERSATION,
            parentId: FORK_DEV_CONVERSATION,
            anchorItemId: seeds.find((seed) => seed.id === input.chatId)?.anchor ?? null,
          },
        }),
      send: (input) => {
        const now = replies.current.get(input.chatId) ?? [];
        replies.current.set(input.chatId, [
          ...now,
          {
            id: `${input.chatId}-${now.length + 1}`,
            threadId: input.chatId,
            seq: now.length + 1,
            role: "user",
            blocks: [{ kind: "text", text: input.text }],
            createdAt: new Date().toISOString(),
            forks: [],
          },
          {
            id: `${input.chatId}-${now.length + 2}`,
            threadId: input.chatId,
            seq: now.length + 2,
            role: "bot",
            blocks: [{ kind: "text", text: "Here’s what I found." }],
            createdAt: new Date().toISOString(),
            forks: [],
          },
        ]);
        return delay({ ok: true as const });
      },
      createFork: (input) => {
        const id = `fork-dev-${nextId.current++}`;
        const seed = {
          id,
          anchor: input.anchorItemId,
          title: input.text.length > 40 ? `${input.text.slice(0, 40)}…` : input.text,
          state: "open" as const,
          updatedAt: new Date().toISOString(),
          messages: [["user", input.text]] as Array<["user" | "bot", string]>,
        };
        replies.current.set(id, forkMessages(seed));
        setSeeds((current) => [...current, seed]);
        return delay(forkChat(seed) satisfies ChatSummary);
      },
      addToConversation: (input) => {
        setSeeds((current) =>
          current.map((seed) =>
            seed.id === input.chatId
              ? {
                  ...seed,
                  state: "added",
                  live: false,
                  summary: "Above $2M only, 6.6% recovers 0.2 points",
                }
              : seed,
          ),
        );
        return delay({ summary: "Above $2M only, 6.6% recovers 0.2 points" });
      },
      unarchive: (input) => {
        setSeeds((current) =>
          current.map((seed) => (seed.id === input.chatId ? { ...seed, state: "open" } : seed)),
        );
        return delay({ ok: true as const });
      },
      archive: (input) => {
        setSeeds((current) =>
          current.map((seed) =>
            seed.id === input.chatId ? { ...seed, state: "archived", live: false } : seed,
          ),
        );
        return delay({ ok: true as const });
      },
    }),
    [seeds],
  );

  const params = new URLSearchParams(window.location.search);
  const opened = useRef(false);
  if (!opened.current) {
    opened.current = true;
    const seed = seeds.find((item) => item.id === params.get("fork"));
    if (seed) {
      queueMicrotask(() =>
        forks.openFork({
          chat: {
            id: seed.id,
            title: seed.title,
            live: Boolean(seed.live),
            unread: false,
            archived: seed.state === "archived",
          },
          anchor: messages.find((message) => message.id === seed.anchor) ?? null,
        }),
      );
    }
    if (params.get("view") === "forks") queueMicrotask(() => forks.setView("forks"));
  }

  const artifactTarget = useMemo<ArtifactTarget>(() => ({ botId: DEV_BOT_ID }), []);
  const bot = { id: DEV_BOT_ID, name: DEV_MUSE_NAME, color: DEV_MUSE_COLOR };
  const overlay = Boolean(forks.thread || forks.ask);

  return (
    <div className="muse-wash flex h-screen gap-3 p-3 text-foreground">
      <MuseSidebar
        botId={DEV_BOT_ID}
        runs={[]}
        messages={[]}
        personName={DEV_PERSON_NAME}
        active="conversation"
        activeChatId={null}
        chatListState={chatList}
        onNavigate={noop}
        onOpenWaiting={noop}
        onOpenSettings={noop}
        onOpenChat={noop}
        onNewDraft={noop}
        forks={forks.rows}
        activeForkId={forks.thread?.chat.id ?? null}
        onOpenFork={forks.openRow}
        onShowForks={forks.showForks}
      />
      <main
        className={cn(
          "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
          "border border-line bg-panel backdrop-blur-xl md:rounded-[18px]",
        )}
      >
        <div className="contents" inert={overlay || undefined}>
          <div className="flex h-14 shrink-0 items-center justify-between border-b border-line px-6">
            <h1 className="text-[15px] font-semibold">Conversation</h1>
            <ForkViewSwitch view={forks.view} onChange={forks.setView} />
          </div>
          {forks.view === "forks" ? (
            <AllForks
              rows={forks.rows}
              filter={forks.filter}
              onFilter={forks.setFilter}
              onOpen={forks.openRow}
              onRestore={(row) =>
                wire.unarchive?.({ botId: DEV_BOT_ID, chatId: row.chatId }) ?? Promise.resolve()
              }
            />
          ) : (
            <Transcript
              museMode
              botDisplayName={DEV_MUSE_NAME}
              museFace={{ color: DEV_MUSE_COLOR, identity: DEV_BOT_ID }}
              museRuns={[]}
              scrollRef={scrollRef}
              scrollRequest={scrollRequest}
              onScrollRequestHandled={noop}
              artifactTarget={artifactTarget}
              messages={messages}
              olderCursor={null}
              loadingOlder={false}
              answerableAskMessageId={null}
              running={false}
              workingBots={[]}
              onLoadOlder={noop}
              onOpenBot={noop}
              onAnswer={noopAsync}
              onReact={noopAsync}
              onJumpToMessage={noop}
              onOpenPeerMessages={noop}
              peerBot={() => undefined}
              onRefresh={noopAsync}
              onBotChanged={noopAsync}
              onAddRoutine={noop}
              voiceReady={false}
              speakingMessageId={null}
              onSpeak={noop}
              onOpenComputer={noop}
              onFork={forks.startAsk}
              renderUnder={forks.renderUnder}
              aside={
                <ForkGutter
                  scrollRef={scrollRef}
                  messages={messages}
                  forks={forks.rows}
                  onJump={forks.jump}
                />
              }
            />
          )}
        </div>
        {forks.ask ? (
          <ForkAsk
            botId={DEV_BOT_ID}
            wire={wire}
            anchor={forks.ask.anchor}
            chatId={forks.ask.chatId}
            onClose={() => forks.setAsk(null)}
            onCreated={forks.created}
            onOpenSideChat={noop}
          />
        ) : null}
        {forks.thread && !forks.ask ? (
          <ForkThread
            key={forks.thread.chat.id}
            bot={bot}
            wire={wire}
            target={forks.thread}
            conversationId={FORK_DEV_CONVERSATION}
            conversationMessages={messages as ThreadMessage[]}
            onClose={forks.closeThread}
            onOpenFork={forks.openFork}
            onAsk={forks.startAsk}
            onOpenSideChat={noop}
            onAdded={(anchorItemId) => {
              forks.closeThread();
              if (anchorItemId) forks.jump(anchorItemId);
            }}
            onArchived={forks.closeThread}
            onRestored={() => forks.thread && forks.markRestored(forks.thread.chat.id)}
            onMissingAnchor={forks.revealAnchor}
          />
        ) : null}
      </main>
    </div>
  );
}
