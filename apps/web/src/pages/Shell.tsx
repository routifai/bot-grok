import { useLingui } from "@lingui/react/macro";
import type { Bot, ChatSummary, ThreadMessage } from "@superchat/contracts";
import { AvatarStyleProvider } from "@superchat/ui-web";
import type { ReactNode } from "react";
import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  flyOrb,
  type OrbFlight,
  OrbHomeProvider,
  orbPlacement,
  SuperchatPresenceProvider,
  useIsDesktop,
} from "../components/ai/orb";
import { ArtifactPanelProvider, AskPreviewsProvider } from "../components/cards/context";
import { SuperchatLogo } from "../components/SuperchatLogo";
import { useSuperchatWork } from "../features/activity";
import { ApprovalCards } from "../features/approvals";
import { appsExtension } from "../features/apps";
import { ArtifactRegistryProvider } from "../features/artifacts/registry";
import { useChatArtifacts } from "../features/artifacts/useChatArtifacts";
import { ChartGallery, chartsExtension, isChartMessage } from "../features/charts";
import { FolderPicker } from "../features/computer/FolderPicker";
import { DeckThemeChoice, decksExtension } from "../features/decks";
import { documentsExtension } from "../features/documents";
import { knowledgeExtension } from "../features/knowledge";
import { ConversationModelPicker } from "../features/models";
import { useChatPlace, WorkInChip } from "../features/projects/WorkIn";
import { sheetsExtension } from "../features/sheets";
import { AllForks } from "../features/side-chats/AllForks";
import { ForkAsk } from "../features/side-chats/ForkAsk";
import { ForkGutter } from "../features/side-chats/ForkGutter";
import type { ForkWire } from "../features/side-chats/ForkOverlay";
import { ForkThread, type ForkThreadTarget } from "../features/side-chats/ForkThread";
import {
  SideChatSession,
  type SideChatView,
  type SideChatWire,
} from "../features/side-chats/SideChatSession";
import { sideChatView } from "../features/side-chats/sideChatView";
import { useChatList } from "../features/side-chats/useChatList";
import { forkChatSummary, useForkView } from "../features/side-chats/useForkView";
import type { ArtifactTarget } from "../lib/artifact-open";
import { watchFamily } from "../lib/family-stream";
import { markAfterPaint, markOnce } from "../lib/performance";
import { rpc } from "../lib/rpc";
import { ChatsPopover } from "./muse/chrome/ChatsPopover";
import { ContourGround } from "./muse/chrome/ContourGround";
import { ConversationActivity } from "./muse/chrome/ConversationActivity";
import { conversationLayout } from "./muse/chrome/conversationLayout";
import { ConnectedDock, type DockKey, SettingsButton } from "./muse/chrome/Dock";
import {
  EmptyConversationLead,
  EmptyConversationSuggestions,
} from "./muse/chrome/EmptyConversation";
import { Home } from "./muse/chrome/Home";
import { HomeActivity } from "./muse/chrome/HomeActivity";
import { BotSettingsPanel } from "./muse/chrome/PanelForms";
import type { Panel } from "./muse/chrome/panel";
import { SidePanelHeader } from "./muse/chrome/SidePanelHeader";
import { useBotRoster } from "./muse/chrome/useBotRoster";
import { useBrowserNotifications } from "./muse/chrome/useBrowserNotifications";
import { type MuseLiveRun, useTurnRuns } from "./muse/chrome/useMuseLiveState";
import { useReplyAlerts } from "./muse/chrome/useReplyAlerts";
import { ClearConversationHost } from "./muse/conversation/ClearConversationHost";
import { Composer } from "./muse/conversation/Composer";
import { Transcript } from "./muse/conversation/Transcript";
import {
  type TranscriptGroup,
  TranscriptGroupProvider,
} from "./muse/conversation/transcriptGroups";
import { useComposerSend } from "./muse/conversation/useComposerSend";
import { useDockTransition } from "./muse/conversation/useDockTransition";
import { useMuseTranscript } from "./muse/conversation/useMuseTranscript";
import { useTranscriptScroll } from "./muse/conversation/useTranscriptScroll";
import { SettingsHost } from "./muse/settings/SettingsHost";
import { useShellSettings } from "./muse/settings/useShellSettings";
import { DockSheets } from "./muse/sheets/DockSheets";

/** Superchat's Mac window (docs/muse/DESIGN.md "Window"): the Conversation and the other screens
 * sit flat on the rounded content window; only the sidebar, the inspector and side panels
 * float as glass inside it. */
/** Every orb brightens while Superchat works (useSuperchatWork). */
const sideChatViewWithApprovals: SideChatView = { ...sideChatView, Approvals: ApprovalCards };

function SuperchatPresence({
  botId,
  runs,
  messages,
  children,
}: {
  botId: string;
  runs: readonly MuseLiveRun[];
  messages: readonly ThreadMessage[] | null;
  children: ReactNode;
}) {
  const { orb } = useSuperchatWork({ botId, runs, messages: messages ?? undefined });
  return <SuperchatPresenceProvider state={orb}>{children}</SuperchatPresenceProvider>;
}

const MUSE_CONTENT_PANE = "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden";

/** What the capabilities built on artifacts add to the panel and the Library cards. */
const ARTIFACT_EXTENSIONS = [
  appsExtension,
  sheetsExtension,
  decksExtension,
  documentsExtension,
  chartsExtension,
  knowledgeExtension,
];

/** Ask cards whose options preview a capability's things, drawn by that capability. */
const ASK_PREVIEWS = { "deck-theme": DeckThemeChoice };

/** The charts the Muse showed in a row (a dashboard reply) draw as one set: KPIs, then a grid. */
const CHART_RUNS: TranscriptGroup = {
  joins: isChartMessage,
  render: (messages) => <ChartGallery messages={messages} />,
};

export function ShellPage() {
  const { t } = useLingui();
  const { botId } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [panel, setPanel] = useState<Panel>(null);
  const { bots, botsRef, initialBotsLoaded, bootstrapMe } = useBotRoster({
    botId,
    navigate,
  });
  const userId = bootstrapMe?.userId;

  const settings = useShellSettings();
  const { openSettings } = settings;

  const [clearTarget, setClearTarget] = useState<Bot | null>(null);

  const active = bots.find((b) => b.id === botId) ?? bots[0];
  // The dock place open as a sheet, if any.
  const [dockSheet, setDockSheet] = useState<DockKey | null>(null);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  // A new side chat opened from Files works in this folder; any other draft has none.
  const [draftFolder, setDraftFolder] = useState<string | null>(null);
  // The open Side Chat, shown as a full-size session replacing the Conversation
  // (agreed behavior #2); "draft" is an unsent one. Cleared by navigating anywhere else.
  const [activeChat, setActiveChat] = useState<ChatSummary | "draft" | null>(null);
  useEffect(() => {
    if (activeChat !== "draft") setDraftFolder(null);
  }, [activeChat]);
  const chatList = useChatList(active?.id ?? "");
  // A search hit inside a side chat (`?chat=…&m=…`): the message to scroll to once it is open.
  const [chatFocus, setChatFocus] = useState<{ chatId: string; messageId: string } | null>(null);
  const sideChatWire = useMemo<SideChatWire>(
    () => ({
      summaryPreview: (input) => rpc.chats.summaryPreview(input),
      createSide: (input) => chatList.createSide(input.start, input.text, input.folder),
      transcript: (input) => rpc.chats.transcript(input),
      watch: (botId, listener) => watchFamily(botId, listener),
      send: (input) => rpc.chats.send(input),
      markRead: (input) => rpc.chats.markRead(input),
      project: (input) => rpc.chats.project(input),
      listFolder: (input) => rpc.files.list(input),
      setFolder: (input) => rpc.chats.setFolder(input),
      unarchive: (input) =>
        rpc.chats.unarchive(input).then((result) => {
          chatList.refresh();
          return result;
        }),
    }),
    [chatList.createSide, chatList.refresh],
  );
  const refreshChatList = chatList.refresh;
  const forkWire = useMemo<ForkWire>(
    () => ({
      ...sideChatWire,
      createFork: (input) =>
        rpc.chats.createFork(input).then((chat) => {
          refreshChatList();
          return chat;
        }),
      addToConversation: (input) => rpc.chats.addToConversation(input),
      archive: (input) =>
        rpc.chats.archive(input).then((result) => {
          refreshChatList();
          return result;
        }),
    }),
    [sideChatWire, refreshChatList],
  );
  const chatArtifacts = useChatArtifacts(
    `${active?.id ?? ""}:${activeChat === "draft" ? "draft" : (activeChat?.id ?? "")}`,
  );
  /** Below `md` the Muse sidebar is an off-canvas drawer opened from the main header. */
  const [_navOpen, _setNavOpen] = useState(false);
  const activeBotId = useRef<string | undefined>(active?.id);
  activeBotId.current = active?.id;
  const { flushPendingBrowserNotifications, notifyBrowserForEvent } =
    useBrowserNotifications(botsRef);
  const { messageScroll, scrollRequest, clearScrollRequest, scrollToMessage } =
    useTranscriptScroll();

  useEffect(() => {
    const messageId = searchParams.get("m");
    if (!active) return;
    const chatParam = searchParams.get("chat");
    if (chatParam) {
      // A hit in a side chat: open it (waiting for the list), then drop the jump URL.
      if (chatList.state.status === "loading") return;
      const chat =
        chatList.state.status === "ready"
          ? chatList.state.chats.find((item) => item.id === chatParam)
          : undefined;
      if (chat?.anchorItemId) {
        // A hit in a fork: it opens over its message, like any other way into a fork.
        setActiveChat(null);
        openForkRef.current({
          chat: {
            id: chat.id,
            title: chat.title,
            live: chat.live,
            unread: Boolean(chat.unread),
            archived: chat.archived,
          },
          anchor: null,
        });
      } else if (chat) {
        setActiveChat(chat);
        if (messageId) setChatFocus({ chatId: chat.id, messageId });
      }
      const next = new URLSearchParams(searchParams);
      next.delete("chat");
      next.delete("m");
      setSearchParams(next, { replace: true });
      return;
    }
    if (messageId) {
      // The Muse's Conversation is the engine's transcript: page back to the hit, then scroll.
      void revealMessageRef
        .current(messageId)
        .then((found) => {
          if (found) scrollToMessage(messageId);
        })
        .finally(() => {
          const next = new URLSearchParams(searchParams);
          next.delete("m");
          setSearchParams(next, { replace: true });
        });
    }
  }, [active?.id, searchParams, setSearchParams, chatList.state]);
  const revealMessageRef = useRef<(messageId: string) => Promise<boolean>>(async () => false);
  const openForkRef = useRef<(target: ForkThreadTarget) => void>(() => undefined);
  // Bumps each time a turn finishes, so the Files view follows the Muse's work.
  const [filesRefreshKey, setFilesRefreshKey] = useState(0);
  // The folder to show in the Files tab, set by the "Working in" chip.
  const [filesReveal, setFilesReveal] = useState<{ path: string; nonce: number } | null>(null);
  const showFolderInFiles = useCallback((path: string) => {
    setFilesReveal((current) => ({ path, nonce: (current?.nonce ?? 0) + 1 }));
    setDockSheet("files");
  }, []);
  const { place: conversationPlace, reload: reloadConversationPlace } = useChatPlace(
    active ? () => rpc.chats.project({ botId: active.id }) : undefined,
    active?.id ?? "",
    filesRefreshKey,
  );
  const listWorkspaceFolder = useCallback(
    (path: string) =>
      active
        ? rpc.files.list({ botId: active.id, path }).then(({ entries }) => entries)
        : Promise.resolve([]),
    [active?.id],
  );
  // The Muse's Conversation is the engine's transcript (ADR 0009), and so is whether it is working.
  const museTranscript = useMuseTranscript(active?.id, messageScroll);
  const running = museTranscript.running;
  const turnRuns = useTurnRuns(`conversation:${active?.id}`, running);
  const wasRunningRef = useRef(false);
  useEffect(() => {
    if (wasRunningRef.current && !running) setFilesRefreshKey((key) => key + 1);
    wasRunningRef.current = running;
  }, [running]);
  useReplyAlerts({
    bot: active,
    conversationId: museTranscript.threadId,
    notifyBrowserForEvent,
  });
  const readTranscript = museTranscript.refresh;
  revealMessageRef.current = museTranscript.reveal;
  const forks = useForkView({
    chatList: chatList.state,
    messages: museTranscript.messages,
    scrollRef: messageScroll,
    reveal: museTranscript.reveal,
    scrollToMessage,
  });
  const resetForks = forks.reset;
  openForkRef.current = forks.openFork;
  // The fork views belong to the Conversation: leaving it (another section, a full-size side
  // chat, another Muse) closes them.
  useEffect(() => {
    if (activeChat) resetForks();
  }, [activeChat, resetForks]);
  useEffect(() => {
    resetForks();
  }, [active?.id, resetForks]);
  const forksView = forks.view === "forks";
  const forkOverlayOpen = Boolean(forks.thread || forks.ask);
  const transcriptMessages = useMemo(
    () =>
      museTranscript.pendingMessage
        ? [...(museTranscript.messages ?? []), museTranscript.pendingMessage]
        : (museTranscript.messages ?? []),
    [museTranscript.messages, museTranscript.pendingMessage],
  );
  // An empty Conversation is a start page: the greeting, the composer centered under it, and
  // a few suggestions; the composer glides down to its dock once the first message lands.
  const startPage =
    !forksView &&
    conversationLayout({
      hasMuse: Boolean(active),
      loaded: museTranscript.messages !== null,
      messageCount: transcriptMessages.length,
      running,
    }) === "start";
  // The start page stays on screen until the orb's flight begins: `shownStart` follows
  // `startPage`, but leaving it runs through flyOrb (a View Transition, a FLIP, or a cut under
  // reduced motion), so the orb reads as one object moving from the center to its home.
  const [shownStart, setShownStart] = useState(startPage);
  const orbFlight = useRef<OrbFlight | null>(null);
  const flightQueued = useRef(false);
  const latestStartPage = useRef(startPage);
  latestStartPage.current = startPage;
  useLayoutEffect(() => {
    if (startPage === shownStart) return;
    if (startPage) {
      setShownStart(true);
      return;
    }
    if (flightQueued.current) return;
    flightQueued.current = true;
    // Out of the commit phase, so the update can flush synchronously inside the transition.
    queueMicrotask(() => {
      flightQueued.current = false;
      if (latestStartPage.current) return;
      orbFlight.current = flyOrb(() => flushSync(() => setShownStart(false)));
    });
  }, [startPage, shownStart]);
  // The greeting landing shows only while the Conversation has never had a message.
  const showHome = Boolean(active && shownStart && !activeChat && !forks.thread && !forks.ask);
  const composerDock = useRef<HTMLDivElement>(null);
  // A View Transition already glides the composer (`superchat-composer`); the FLIP is the fallback.
  useDockTransition(composerDock, shownStart, () => orbFlight.current === "view-transition");
  const _isDesktop = useIsDesktop();
  const orbHome = orbPlacement({
    startPage: shownStart,
    sidebarVisible: false,
  });
  const transcriptArtifactTarget = useMemo<ArtifactTarget>(
    () => ({ botId: active?.id ?? "" }),
    [active?.id],
  );
  const shellReady =
    initialBotsLoaded && (bots.length === 0 || Boolean(active && museTranscript.messages));

  useLayoutEffect(() => {
    if (initialBotsLoaded) {
      markOnce("rk:renderer:bots-committed");
      markAfterPaint("rk:renderer:bots-painted");
    }
    if (active && museTranscript.messages) {
      markOnce("rk:renderer:thread-committed");
      markAfterPaint("rk:renderer:thread-painted");
    }
    if (shellReady) {
      markOnce("rk:renderer:shell-ready");
      markAfterPaint("rk:renderer:shell-painted");
    }
  }, [active, initialBotsLoaded, shellReady, museTranscript.messages]);

  const {
    activePendingAttachments,
    activePendingFolders,
    attachFolder,
    removeFolder,
    setReplyTarget,
    setReplyQuote,
    replyTarget,
    replyQuote,
    clearReply,
    sending,
    sendError,
    composerSeed,
    setComposerSeed,
    attachmentNotice,
    uploadStatus,
    fileInputRef,
    followSignal,
    failure,
    dismissComposerError,
    answerMessage,
    onAttachmentPick,
    removeAttachment,
    retryAttachment,
    sendMessage,
    sendCardReply,
    stopRun,
  } = useComposerSend({
    active,
    activeBotId,
    userId,
    messages: transcriptMessages,
    transcript: museTranscript,
    botsRef,
    flushPendingBrowserNotifications,
  });
  const replyTargetName = replyTarget
    ? replyTarget.role === "user"
      ? t`You`
      : (active?.name ?? t`Bot`)
    : undefined;
  const startChat = useCallback(
    (input: { send?: string; seed?: string }) => {
      setActiveChat(null);
      if (input.seed) setComposerSeed(input.seed);
      if (input.send) void sendMessage(input.send);
    },
    [sendMessage],
  );
  const userName = bootstrapMe?.name ?? t`You`;

  const composerEl = (
    <Composer
      key={`bot:${active?.id}`}
      activeName={active?.name}
      running={running}
      pendingAttachments={activePendingAttachments}
      pendingFolders={activePendingFolders}
      onAttachFolder={active ? () => setFolderPickerOpen(true) : undefined}
      onRemoveFolder={removeFolder}
      attachmentNotice={attachmentNotice}
      uploadStatus={uploadStatus}
      sendError={sendError}
      failure={failure}
      onDismissError={dismissComposerError}
      sending={sending}
      fileInputRef={fileInputRef}
      onAttachmentPick={onAttachmentPick}
      onRemoveAttachment={removeAttachment}
      onRetryAttachment={retryAttachment}
      onSend={(...args: Parameters<typeof sendMessage>) => {
        return sendMessage(...args);
      }}
      seedText={composerSeed}
      onSeedConsumed={() => setComposerSeed(null)}
      onStop={stopRun}
      replyTarget={replyTarget}
      replyQuote={replyQuote}
      replyTargetName={replyTargetName}
      onClearReply={clearReply}
      onSlashAction={(action) => {
        if (action === "chat-settings") {
          setPanel("settings");
          return;
        }
        if (action === "settings-general") {
          openSettings("general");
          return;
        }
      }}
    />
  );

  // The superchat top bar: the Project, the fork switch, the model and Chats.
  const superchatTopBar = active ? (
    <div className="app-drag relative z-10 flex h-[84px] min-w-0 shrink-0 items-center gap-3 ps-4 pe-4 md:ps-0 md:pe-6">
      <SuperchatLogo className="md:hidden" />
      <span className="min-w-0 flex-1" />
      <div className="app-no-drag flex shrink-0 items-center gap-2">
        {activeChat ? null : (
          <span className="app-no-drag hidden md:inline-flex">
            <WorkInChip
              align="end"
              place={conversationPlace}
              list={listWorkspaceFolder}
              onShow={showFolderInFiles}
              onPick={(folder) =>
                rpc.chats.setFolder({ botId: active.id, folder }).then(reloadConversationPlace)
              }
            />
          </span>
        )}
        <ConversationModelPicker botId={active.id} />
        <ChatsPopover
          botId={active.id}
          state={chatList.state}
          forks={forks.rows}
          current={!activeChat && !forks.thread}
          activeChatId={activeChat && activeChat !== "draft" ? activeChat.id : null}
          onOpenConversation={() => {
            forks.reset();
            setActiveChat(null);
          }}
          onOpenChat={setActiveChat}
          onNewDraft={() => setActiveChat("draft")}
          onOpenFork={(row) => {
            setActiveChat(null);
            forks.openRow(row);
          }}
          onShowForks={(filter) => {
            setActiveChat(null);
            forks.showForks(filter);
          }}
          onChanged={() => {
            chatList.refresh();
            readTranscript();
          }}
        />
      </div>
    </div>
  ) : null;

  const shell = (
    <div
      data-testid="shell-root"
      data-ready={shellReady}
      className="superchat-window relative flex h-full min-w-0 flex-1 overflow-hidden text-foreground"
    >
      {showHome && active ? (
        <Home
          personName={bootstrapMe?.name ?? ""}
          dock={<ConnectedDock botId={active.id} active={dockSheet} onSelect={setDockSheet} />}
          composer={composerEl}
          onOpenSettings={() => openSettings("general")}
          recent={<HomeActivity botId={active.id} hideWhenEmpty />}
        />
      ) : null}
      {active && !showHome ? <ContourGround /> : null}
      {active && !showHome ? (
        <SuperchatLogo className="absolute start-8 top-7 z-20 hidden md:inline-flex" />
      ) : null}
      {active && !showHome ? (
        <div className="relative z-10 hidden w-[96px] shrink-0 flex-col items-center justify-between pt-24 pb-6 md:flex">
          <span />
          <ConnectedDock botId={active.id} active={dockSheet} onSelect={setDockSheet} />
          <SettingsButton onClick={() => openSettings("general")} />
        </div>
      ) : null}

      <main className="relative z-10 flex min-w-0 flex-1 flex-col">
        {activeChat ? superchatTopBar : null}
        {active && activeChat ? (
          <div className="flex min-h-0 flex-1">
            <div className={MUSE_CONTENT_PANE}>
              <SideChatSession
                chat={activeChat}
                folder={activeChat === "draft" ? draftFolder : null}
                bot={{ id: active.id, name: active.name, color: active.color }}
                view={sideChatViewWithApprovals}
                wire={sideChatWire}
                onCreated={setActiveChat}
                onReplied={chatList.refresh}
                onClose={() => setActiveChat(null)}
                onShowFolder={showFolderInFiles}
                onShowAsFork={(chat) => {
                  setActiveChat(null);
                  forks.openChat(chat);
                }}
                onRestored={() =>
                  setActiveChat((current) =>
                    current && current !== "draft" ? { ...current, archived: false } : current,
                  )
                }
                focusMessageId={
                  activeChat !== "draft" && chatFocus?.chatId === activeChat.id
                    ? chatFocus.messageId
                    : undefined
                }
              />
            </div>
            {chatArtifacts.panel}
          </div>
        ) : (
          <div className={active ? "flex min-h-0 flex-1" : "contents"}>
            <div className={active ? MUSE_CONTENT_PANE : "contents"}>
              {/* Behind a fork's thread view or "lift and ask", the Conversation is out of reach. */}
              <div className="contents" inert={forkOverlayOpen || undefined}>
                {superchatTopBar}
                {forksView ? (
                  <AllForks
                    rows={forks.rows}
                    filter={forks.filter}
                    onFilter={forks.setFilter}
                    onOpen={forks.openRow}
                    onRestore={
                      active
                        ? async (row) => {
                            await forkWire.unarchive?.({ botId: active.id, chatId: row.chatId });
                            readTranscript();
                          }
                        : undefined
                    }
                  />
                ) : shownStart ? (
                  <EmptyConversationLead personName={bootstrapMe?.name ?? ""} />
                ) : active ? (
                  <Transcript
                    key={museTranscript.threadId ?? active.id}
                    botDisplayName={active.name}
                    followSignal={followSignal}
                    museFace={{ color: active.color, identity: active.id }}
                    museRuns={turnRuns}
                    scrollRef={messageScroll}
                    scrollRequest={scrollRequest}
                    onScrollRequestHandled={clearScrollRequest}
                    artifactTarget={transcriptArtifactTarget}
                    messages={transcriptMessages}
                    olderCursor={museTranscript.olderCursor}
                    loadingOlder={museTranscript.loadingOlder}
                    running={running}
                    onLoadOlder={museTranscript.loadOlder}
                    onShowEarlier={
                      museTranscript.canShowEarlier ? museTranscript.showEarlier : undefined
                    }
                    onAnswer={answerMessage}
                    onSendCard={sendCardReply}
                    onReply={(message) => {
                      setReplyTarget(message);
                      setReplyQuote(null);
                    }}
                    onQuote={(message, quote) => {
                      setReplyTarget(message);
                      setReplyQuote(quote);
                    }}
                    trailing={<ApprovalCards botId={active.id} chatId={null} />}
                    onFork={forks.startAsk}
                    renderUnder={forks.renderUnder}
                    aside={
                      <ForkGutter
                        scrollRef={messageScroll}
                        messages={transcriptMessages}
                        forks={forks.rows}
                        onJump={forks.jump}
                      />
                    }
                  />
                ) : null}
                {active ? (
                  // Kept mounted under the Forks list so a half-written message survives.
                  <div
                    ref={composerDock}
                    hidden={forksView || undefined}
                    style={{ viewTransitionName: "superchat-composer" }}
                  >
                    {showHome ? null : composerEl}
                  </div>
                ) : null}
                {shownStart ? (
                  <EmptyConversationSuggestions onSend={(text) => void sendMessage(text)} />
                ) : null}
              </div>
              {active && forks.ask ? (
                <ForkAsk
                  botId={active.id}
                  wire={forkWire}
                  anchor={forks.ask.anchor}
                  chatId={forks.ask.chatId}
                  onClose={() => forks.setAsk(null)}
                  onCreated={forks.created}
                  onOpenSideChat={(chat) => {
                    chatList.refresh();
                    setActiveChat(chat);
                  }}
                />
              ) : null}
              {active && forks.thread && !forks.ask ? (
                <ForkThread
                  key={forks.thread.chat.id}
                  bot={{ id: active.id, name: active.name, color: active.color }}
                  wire={forkWire}
                  target={forks.thread}
                  conversationId={museTranscript.threadId}
                  conversationMessages={transcriptMessages}
                  onClose={forks.closeThread}
                  onOpenFork={forks.openFork}
                  onAsk={forks.startAsk}
                  onOpenSideChat={(chat) => setActiveChat(forkChatSummary(chat, chatList.state))}
                  onAdded={(anchorItemId) => {
                    readTranscript();
                    forks.closeThread();
                    if (anchorItemId) forks.jump(anchorItemId);
                  }}
                  onArchived={forks.closeThread}
                  onRestored={() => {
                    if (forks.thread) forks.markRestored(forks.thread.chat.id);
                    readTranscript();
                  }}
                  onReplied={chatList.refresh}
                  onMissingAnchor={forks.revealAnchor}
                />
              ) : null}
            </div>
            {active ? chatArtifacts.panel : null}
            {active && !chatArtifacts.isOpen ? (
              <div className="pointer-events-none absolute end-5 bottom-24 z-20 hidden md:block xl:bottom-6 [&>*]:pointer-events-auto">
                <ConversationActivity botId={active.id} />
              </div>
            ) : null}
          </div>
        )}
      </main>

      {active ? (
        <FolderPicker
          botId={active.id}
          open={folderPickerOpen}
          onClose={() => setFolderPickerOpen(false)}
          onPick={attachFolder}
        />
      ) : null}
      {active ? (
        <DockSheets
          botId={active.id}
          sheet={dockSheet}
          onClose={() => setDockSheet(null)}
          filesRefreshKey={filesRefreshKey}
          filesReveal={filesReveal}
          onStartChat={startChat}
          onOpenFolderChat={(folder) => {
            forks.reset();
            setDraftFolder(folder);
            setActiveChat("draft");
          }}
        />
      ) : null}

      <aside
        data-testid="side-panel"
        data-panel={panel ?? "closed"}
        className={`superchat-glass absolute inset-y-0 end-0 z-20 flex min-h-0 shrink-0 flex-col overflow-hidden transition-[width] duration-150 ease-out md:relative ${
          panel && active
            ? // An inset panel like <main>.
              "w-full max-w-[400px] md:m-2 md:w-[400px] md:max-w-none"
            : "pointer-events-none w-0"
        }`}
      >
        {panel && active ? (
          <div className="rk-scroll h-full w-full overflow-y-auto px-5 py-[17px] md:w-[400px]">
            <SidePanelHeader panel={panel} setPanel={setPanel} active={active} />
            {panel === "settings" && active ? (
              <BotSettingsPanel onClear={() => setClearTarget(active)} />
            ) : null}
          </div>
        ) : null}
      </aside>

      <Suspense fallback={null}>
        {clearTarget ? (
          <ClearConversationHost
            bot={clearTarget}
            onClose={() => setClearTarget(null)}
            onCleared={readTranscript}
          />
        ) : null}
      </Suspense>

      <Suspense fallback={null}>
        <SettingsHost
          settings={settings}
          userName={userName}
          email={bootstrapMe?.userId}
          active={active}
        />
      </Suspense>
    </div>
  );

  return (
    <AvatarStyleProvider value={bootstrapMe?.avatarStyle ?? "robot"}>
      <ArtifactPanelProvider value={chatArtifacts.api}>
        <ArtifactRegistryProvider value={ARTIFACT_EXTENSIONS}>
          <TranscriptGroupProvider value={CHART_RUNS}>
            <AskPreviewsProvider value={ASK_PREVIEWS}>
              {/* The window ground around Superchat's rounded content window. */}
              <div className="muse-wash pt-safe pb-safe ps-safe pe-safe flex h-full md:p-2">
                {active ? (
                  <OrbHomeProvider home={orbHome}>
                    <SuperchatPresence
                      botId={active.id}
                      runs={turnRuns}
                      messages={museTranscript.messages}
                    >
                      {shell}
                    </SuperchatPresence>
                  </OrbHomeProvider>
                ) : (
                  shell
                )}
              </div>
            </AskPreviewsProvider>
          </TranscriptGroupProvider>
        </ArtifactRegistryProvider>
      </ArtifactPanelProvider>
    </AvatarStyleProvider>
  );
}
