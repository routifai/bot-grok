import type { ChatSummary, ThreadMessage } from "@aiden/contracts";
import { useMemo, useRef, useState } from "react";
import type { MuseRailView } from "../../components/AppRail";
import { MuseSidebar } from "../muse/chrome/MuseSidebar";
import { SideChatSession, type SideChatWire } from "../muse/chrome/SideChatSession";
import type { ChatListState } from "../muse/chrome/useChatList";
import { sideChatView } from "../muse/conversation/sideChatView";
import {
  DEV_BOT_ID,
  DEV_PERSON_NAME,
  DEV_SUMMARY,
  INITIAL_SIDE_CHATS,
  SIDE_CHAT_FIXTURE_MESSAGES,
} from "./side-chat-fixture";

function delay<T>(value: T, ms = 450): Promise<T> {
  return new Promise((resolve) => {
    window.setTimeout(() => resolve(value), ms);
  });
}

/**
 * Dev-only route (`/dev/side-chats`, gated by `import.meta.env.DEV` in App.tsx, following
 * `/dev/canvas`): the real `MuseSidebar` and `SideChatSession` wired to in-memory fixture
 * data instead of the `chats.*` wire, which the real backend doesn't serve yet. Lets the
 * draft → first message → created flow be exercised without a session or a backend.
 */
export function SideChatsPreviewPage() {
  const [chats, setChats] = useState<ChatSummary[]>(INITIAL_SIDE_CHATS);
  const [museView, setMuseView] = useState<MuseRailView>("conversation");
  // `?chat=<id>` opens a fixture chat straight away (e.g. `?chat=side-cards`).
  const [activeChat, setActiveChat] = useState<ChatSummary | "draft" | null>(
    () =>
      INITIAL_SIDE_CHATS.find(
        (chat) => chat.id === new URLSearchParams(window.location.search).get("chat"),
      ) ?? null,
  );
  const messagesByChat = useRef(new Map(Object.entries(SIDE_CHAT_FIXTURE_MESSAGES)));
  const nextId = useRef(1);

  const chatListState: ChatListState = { status: "ready", chats };

  const wire = useMemo<SideChatWire>(
    () => ({
      summaryPreview: () => delay({ summary: DEV_SUMMARY }),
      createSide: (input) => {
        const id = `side-dev-${nextId.current++}`;
        const now = new Date().toISOString();
        const chat: ChatSummary = {
          id,
          title: input.text.length > 48 ? `${input.text.slice(0, 48)}…` : input.text,
          start: input.start,
          summary: input.start === "withContext" ? DEV_SUMMARY : null,
          archived: false,
          live: false,
          updatedAt: now,
        };
        const first: ThreadMessage = {
          id: `${id}-1`,
          threadId: id,
          seq: 1,
          role: "user",
          blocks: [{ kind: "text", text: input.text }],
          createdAt: now,
        };
        messagesByChat.current.set(id, [first]);
        return delay(chat).then((created) => {
          setChats((current) => [created, ...current]);
          return created;
        });
      },
      messages: (input) =>
        delay({
          threadId: input.chatId,
          messages: messagesByChat.current.get(input.chatId) ?? [],
          olderCursor: null,
        }),
      send: (input) => {
        const existing = messagesByChat.current.get(input.chatId) ?? [];
        const sent: ThreadMessage = {
          id: `${input.chatId}-${existing.length + 1}`,
          threadId: input.chatId,
          seq: existing.length + 1,
          role: "user",
          blocks: [{ kind: "text", text: input.text }],
          createdAt: new Date().toISOString(),
        };
        messagesByChat.current.set(input.chatId, [...existing, sent]);
        return delay({ ok: true as const });
      },
    }),
    [],
  );

  return (
    <div className="flex h-screen gap-2 bg-background p-2">
      <MuseSidebar
        botId={DEV_BOT_ID}
        runs={[]}
        messages={[]}
        personName={DEV_PERSON_NAME}
        active={museView}
        activeChatId={activeChat === "draft" ? "draft" : (activeChat?.id ?? null)}
        chatListState={chatListState}
        onNavigate={(view) => {
          setActiveChat(null);
          setMuseView(view);
        }}
        onOpenWaiting={() => undefined}
        onOpenSettings={() => undefined}
        onOpenChat={setActiveChat}
        onNewDraft={() => setActiveChat("draft")}
      />
      <main className="flex min-h-0 flex-1 overflow-hidden rounded-2xl border border-border bg-card">
        {activeChat ? (
          <SideChatSession
            bot={{ id: DEV_BOT_ID, name: "Nova", color: "#6366f1" }}
            view={sideChatView}
            chat={activeChat}
            wire={wire}
            onCreated={setActiveChat}
            onClose={() => setActiveChat(null)}
          />
        ) : (
          <div className="grid flex-1 place-items-center px-6 text-center text-[14px] text-muted-foreground">
            The Conversation isn't part of this preview — open a side chat, or start one.
          </div>
        )}
      </main>
    </div>
  );
}
