import { useLingui } from "@lingui/react/macro";
import type { Bot } from "@superchat/contracts";
import { AvatarStyleProvider } from "@superchat/ui-web";
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
import {
  stripOf,
  transcriptWork,
  useLiveTurnActivity,
  useWorkState,
  WorkingPill,
} from "../features/activity";
import { ApprovalCards } from "../features/approvals";
import { appsExtension } from "../features/apps";
import { ArtifactRegistryProvider } from "../features/artifacts/registry";
import { useChatArtifacts } from "../features/artifacts/useChatArtifacts";
import { chartsExtension } from "../features/charts";
import { DeckThemeChoice, decksExtension } from "../features/decks";
import { documentsExtension } from "../features/documents";
import { FolderPicker } from "../features/files/FolderPicker";
import { knowledgeExtension } from "../features/knowledge";
import { liveExtension } from "../features/live";
import { ConversationModelPicker } from "../features/models";
import { useChatPlace, WorkInChip } from "../features/projects/WorkIn";
import {
  newestTurn,
  SessionPanel,
  SessionPanelToggle,
  useSessionPanelOpen,
} from "../features/session-panel";
import { sheetsExtension } from "../features/sheets";
import type { ArtifactTarget } from "../lib/artifact-open";
import { markAfterPaint, markOnce } from "../lib/performance";
import { rpc } from "../lib/rpc";
import { ShowMessageProvider } from "../lib/show-message";
import { useTurnRuns } from "../lib/useMuseLiveState";
import { ContourGround } from "./app/chrome/ContourGround";
import { ConversationActivity } from "./app/chrome/ConversationActivity";
import { conversationLayout } from "./app/chrome/conversationLayout";
import type { DockKey } from "./app/chrome/Dock";
import { ConnectedDock, SettingsButton } from "./app/chrome/Dock";
import {
  EmptyConversationLead,
  EmptyConversationSuggestions,
} from "./app/chrome/EmptyConversation";
import { Home } from "./app/chrome/Home";
import { HomeActivity } from "./app/chrome/HomeActivity";
import { BotSettingsPanel } from "./app/chrome/PanelForms";
import type { Panel } from "./app/chrome/panel";
import { SidePanelHeader } from "./app/chrome/SidePanelHeader";
import { useBotRoster } from "./app/chrome/useBotRoster";
import { useBrowserNotifications } from "./app/chrome/useBrowserNotifications";
import { useReplyAlerts } from "./app/chrome/useReplyAlerts";
import { ClearConversationHost } from "./app/conversation/ClearConversationHost";
import { Composer } from "./app/conversation/Composer";
import { Transcript } from "./app/conversation/Transcript";
import { useComposerSend } from "./app/conversation/useComposerSend";
import { useDockTransition } from "./app/conversation/useDockTransition";
import { useMuseTranscript } from "./app/conversation/useMuseTranscript";
import { useTranscriptScroll } from "./app/conversation/useTranscriptScroll";
import { SettingsHost } from "./app/settings/SettingsHost";
import { useShellSettings } from "./app/settings/useShellSettings";
import { DockSheets } from "./app/sheets/DockSheets";

/** Superchat's Mac window (the old design notes "Window"): the Conversation and the other screens
 * sit flat on the rounded content window; only the sidebar, the inspector and side panels
 * float as glass inside it. */
const MUSE_CONTENT_PANE = "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden";

/** What the capabilities built on artifacts add to the panel and the Library cards. */
const ARTIFACT_EXTENSIONS = [
  appsExtension,
  sheetsExtension,
  decksExtension,
  documentsExtension,
  chartsExtension,
  knowledgeExtension,
  liveExtension,
];

/** Ask cards whose options preview a capability's things, drawn by that capability. */
const ASK_PREVIEWS = { "deck-theme": DeckThemeChoice };

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
  const chatArtifacts = useChatArtifacts(active?.id ?? "");
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
  }, [active?.id, searchParams, setSearchParams]);
  const revealMessageRef = useRef<(messageId: string) => Promise<boolean>>(async () => false);
  // A version's "from your message": the same reveal-and-scroll a search hit uses (`?m=`).
  const showMessage = useCallback(
    (itemId: string) =>
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.set("m", itemId);
          return next;
        },
        { replace: true },
      ),
    [setSearchParams],
  );
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
  useReplyAlerts({
    bot: active,
    conversationId: museTranscript.threadId,
    notifyBrowserForEvent,
  });
  const readTranscript = museTranscript.refresh;
  revealMessageRef.current = museTranscript.reveal;
  // The person's message on its way, then the reply as it streams, until the transcript has them.
  const { messages: storedMessages, pendingMessage, liveMessage } = museTranscript;
  const transcriptMessages = useMemo(() => {
    const unstored = [pendingMessage, liveMessage].filter((message) => message !== null);
    return unstored.length ? [...(storedMessages ?? []), ...unstored] : (storedMessages ?? []);
  }, [storedMessages, pendingMessage, liveMessage]);
  // Each reply's strip and where the running work began, read once (ADR 0023).
  // The running turn's Activity from the Conversation's status: its steps show before any reply.
  const liveActivityId = useLiveTurnActivity(
    active?.id,
    museTranscript.threadId,
    museTranscript.turn.running || museTranscript.turn.awaiting,
  );
  const work = useMemo(
    () => transcriptWork(transcriptMessages, liveActivityId),
    [transcriptMessages, liveActivityId],
  );
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
    stopping,
    stopFailed,
    clearStopFailed,
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
    openArtifact: chatArtifacts.shown,
    botsRef,
    flushPendingBrowserNotifications,
  });
  // Whether Superchat is working: the one reading every surface below takes as a prop.
  const workState = useWorkState({
    botId: active?.id,
    turn: museTranscript.turn,
    sending,
    stopping,
    turnStartedAt: work.runningSince ?? null,
  });
  const running = workState.running;
  const turnRuns = useTurnRuns(`conversation:${active?.id}`, workState.turnRunning);
  // "Couldn't stop" says so only while the work still runs.
  useEffect(() => {
    if (!running) clearStopFailed();
  }, [running, clearStopFailed]);
  const wasRunningRef = useRef(false);
  useEffect(() => {
    if (wasRunningRef.current && !running) setFilesRefreshKey((key) => key + 1);
    wasRunningRef.current = running;
  }, [running]);
  // An empty Conversation is a start page: the greeting, the composer centered under it, and
  // a few suggestions; the composer glides down to its dock once the first message lands.
  const startPage =
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
  const showHome = Boolean(active && shownStart);
  const composerDock = useRef<HTMLDivElement>(null);
  // A View Transition already glides the composer (`superchat-composer`); the FLIP is the fallback.
  useDockTransition(composerDock, shownStart, () => orbFlight.current === "view-transition");
  const _isDesktop = useIsDesktop();
  // The session panel (ADR 0027) opens beside the transcript when work runs (desktop only; a
  // phone opens it from the header), and stays closed once the viewer closed it.
  const sessionPanel = useSessionPanelOpen(running && _isDesktop);
  const planTurn = useMemo(() => newestTurn(work), [work]);
  // The panel follows the newest reply (never an older one's plan) and reads the same strip (its plan, fold and the latest line of the work).
  const panelStrip = useMemo(() => {
    if (!planTurn) return null;
    const strip = stripOf(planTurn, workState, undefined);
    // The running turn before a reply: its Helpers come from the feed, lit while anything runs.
    return planTurn === work.pending ? { ...strip, lit: workState.running } : strip;
  }, [planTurn, workState, work.pending]);
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

  const replyTargetName = replyTarget
    ? replyTarget.role === "user"
      ? t`You`
      : (active?.name ?? t`Bot`)
    : undefined;
  const startChat = useCallback(
    (input: { send?: string; seed?: string }) => {
      if (input.seed) setComposerSeed(input.seed);
      if (input.send) void sendMessage(input.send);
    },
    [sendMessage],
  );
  const userName = bootstrapMe?.name ?? t`You`;

  const composerEl = (
    <Composer
      key={`bot:${active?.id}`}
      botId={active?.id}
      activeName={active?.name}
      phase={workState.phase}
      stopFailed={stopFailed && running}
      pendingAttachments={activePendingAttachments}
      pendingFolders={activePendingFolders}
      onAttachFolder={active ? () => setFolderPickerOpen(true) : undefined}
      onRemoveFolder={removeFolder}
      attachmentNotice={attachmentNotice}
      uploadStatus={uploadStatus}
      sendError={sendError}
      failure={failure}
      onDismissError={dismissComposerError}
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

  // The superchat top bar: the Project and the model.
  const superchatTopBar = active ? (
    <div className="app-drag relative z-10 flex h-[84px] min-w-0 shrink-0 items-center gap-3 ps-4 pe-4 md:ps-0 md:pe-6">
      <SuperchatLogo className="md:hidden" />
      <span className="min-w-0 flex-1" />
      <div className="app-no-drag flex shrink-0 items-center gap-2">
        {/* Running work shows here too, for when its strip is scrolled away (ADR 0023). */}
        <WorkingPill work={workState} />
        {running || planTurn ? (
          <SessionPanelToggle
            open={sessionPanel.open}
            onToggle={sessionPanel.open ? sessionPanel.close : sessionPanel.show}
          />
        ) : null}
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
        <ConversationModelPicker botId={active.id} />
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
        <div className={active ? "flex min-h-0 flex-1" : "contents"}>
          <div className={active ? MUSE_CONTENT_PANE : "contents"}>
            {superchatTopBar}
            {shownStart ? (
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
                work={work}
                workState={workState}
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
                trailing={<ApprovalCards botId={active.id} />}
              />
            ) : null}
            {active ? (
              <div ref={composerDock} style={{ viewTransitionName: "superchat-composer" }}>
                {showHome ? null : composerEl}
              </div>
            ) : null}
            {shownStart ? (
              <EmptyConversationSuggestions onSend={(text) => void sendMessage(text)} />
            ) : null}
          </div>
          {active && !chatArtifacts.isOpen ? (
            <SessionPanel
              botId={active.id}
              strip={panelStrip}
              open={sessionPanel.open}
              onClose={sessionPanel.close}
            />
          ) : null}
          {active ? chatArtifacts.panel : null}
          {active && !chatArtifacts.isOpen && !sessionPanel.open ? (
            <div className="pointer-events-none absolute end-5 bottom-24 z-20 hidden md:block xl:bottom-6 [&>*]:pointer-events-auto">
              <ConversationActivity botId={active.id} />
            </div>
          ) : null}
        </div>
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
          <div className="sc-scroll h-full w-full overflow-y-auto px-5 py-[17px] md:w-[400px]">
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
        <ShowMessageProvider value={showMessage}>
          <ArtifactRegistryProvider value={ARTIFACT_EXTENSIONS}>
            <AskPreviewsProvider value={ASK_PREVIEWS}>
              {/* The window ground around Superchat's rounded content window. */}
              <div className="muse-wash pt-safe pb-safe ps-safe pe-safe flex h-full md:p-2">
                {active ? (
                  <OrbHomeProvider home={orbHome}>
                    {/* Every orb brightens while Superchat works. */}
                    <SuperchatPresenceProvider state={running ? "working" : "idle"}>
                      {shell}
                    </SuperchatPresenceProvider>
                  </OrbHomeProvider>
                ) : (
                  shell
                )}
              </div>
            </AskPreviewsProvider>
          </ArtifactRegistryProvider>
        </ShowMessageProvider>
      </ArtifactPanelProvider>
    </AvatarStyleProvider>
  );
}
