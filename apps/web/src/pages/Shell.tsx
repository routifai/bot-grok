import { Trans, useLingui } from "@lingui/react/macro";
import type {
  Bot,
  ChatSummary,
  Connection,
  ConnectionCatalogItem,
  Routine,
  ThreadMessage,
} from "@superchat/contracts";
import { buildComposerMentionOptions, userVisibleMessages } from "@superchat/core";
import { AvatarStyleProvider, Button } from "@superchat/ui-web";
import { Plus } from "lucide-react";
import type { ReactNode } from "react";
import {
  lazy,
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
import { ComputerUpdateProgress } from "../features/computer/ComputerUpdateProgress";
import { FolderPicker } from "../features/computer/FolderPicker";
import { HostComputerPrompt } from "../features/computer/HostComputerPrompt";
import { DeckThemeChoice, decksExtension } from "../features/decks";
import { knowledgeExtension } from "../features/knowledge";
import { ConversationModelPicker } from "../features/models";
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
import { useAgentSkills } from "../features/skills/useAgentSkills";
import type { ArtifactTarget } from "../lib/artifact-open";
import { authClient } from "../lib/auth";
import { watchFamily } from "../lib/family-stream";
import { markAfterPaint, markOnce } from "../lib/performance";
import { rpc } from "../lib/rpc";
import type { CallConversation } from "./CallView";
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
import { museMode } from "./muse/chrome/museMode";
import { BotSettingsPanel } from "./muse/chrome/PanelForms";
import { type ChatProject, ProjectChip, useChatProject } from "./muse/chrome/ProjectChip";
import type { Panel } from "./muse/chrome/panel";
import { SidePanelHeader } from "./muse/chrome/SidePanelHeader";
import { useBotRoster } from "./muse/chrome/useBotRoster";
import { useBrowserNotifications } from "./muse/chrome/useBrowserNotifications";
import { useCreateBot } from "./muse/chrome/useCreateBot";
import { type MuseLiveRun, useTurnRuns } from "./muse/chrome/useMuseLiveState";
import { useReplyAlerts } from "./muse/chrome/useReplyAlerts";
import { useVoice } from "./muse/chrome/useVoice";
import { ClearConversationHost } from "./muse/conversation/ClearConversationHost";
import { Composer } from "./muse/conversation/Composer";
import { FALLBACK_BOT_COLOR } from "./muse/conversation/shared";
import { Transcript } from "./muse/conversation/Transcript";
import {
  type TranscriptGroup,
  TranscriptGroupProvider,
} from "./muse/conversation/transcriptGroups";
import { useComposerSend } from "./muse/conversation/useComposerSend";
import { useDockTransition } from "./muse/conversation/useDockTransition";
import { useMuseTranscript } from "./muse/conversation/useMuseTranscript";
import { useTranscriptScroll } from "./muse/conversation/useTranscriptScroll";
import { RoutinePanel } from "./muse/routines/RoutinePanel";
import { useRoutineEditor } from "./muse/routines/useRoutineEditor";
import { IntegrationOverlays } from "./muse/settings/IntegrationOverlays";
import { SettingsHost } from "./muse/settings/SettingsHost";
import { useShellSettings } from "./muse/settings/useShellSettings";
import { DockSheets } from "./muse/sheets/DockSheets";
import { draftFromRoutine } from "./RoutineEditor";
import { CreateBotForm } from "./shell/bot-panel";
import { DeleteItemDialog } from "./shell/dialogs";

const PeerMessagesOverlay = lazy(() =>
  import("./PeerMessagesOverlay").then((module) => ({ default: module.PeerMessagesOverlay })),
);
const SkillsSection = lazy(() =>
  import("../features/skills/SkillsSection").then((module) => ({ default: module.SkillsSection })),
);
const CallView = lazy(() => import("./CallView").then((module) => ({ default: module.CallView })));

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
  const session = authClient.useSession();
  const userId = session.data?.user.id;

  const [panel, setPanel] = useState<Panel>(null);
  const [peerConversation, setPeerConversation] = useState<{
    peerBotId: string;
    peerBotName: string;
  } | null>(null);
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [routinesBotId, setRoutinesBotId] = useState<string | null>(null);
  const { agentSkills, setAgentSkills, refreshAgentSkills } = useAgentSkills();
  const [mentionRoutines, setMentionRoutines] = useState<Array<Routine & { botName?: string }>>([]);
  const [mentionConnectors, setMentionConnectors] = useState<
    Array<{
      id: string;
      name: string;
      authStatus: "connected" | "needs_auth";
      connectionId?: string;
    }>
  >([]);
  const { bots, setBots, botsRef, initialBotsLoaded, bootstrapMe, setBootstrapMe, refreshBots } =
    useBotRoster({ botId, navigate });

  const settings = useShellSettings(session.data?.user);
  const { messagingProviders, openSettings, setUsage } = settings;
  const [callOpen, setCallOpen] = useState(false);

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
      createSide: (input) => chatList.createSide(input.start, input.text),
      transcript: (input) => rpc.chats.transcript(input),
      watch: (botId, listener) => watchFamily(botId, listener),
      send: (input) => rpc.chats.send(input),
      markRead: (input) => rpc.chats.markRead(input),
      project: (input) => rpc.chats.project(input),
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
  const refreshRoutines = useCallback(async (id: string) => {
    const rows = await rpc.routines.list({ botId: id });
    if (activeBotId.current !== id) return;
    setRoutines(rows);
    setRoutinesBotId(id);
  }, []);
  useEffect(() => {
    if (active?.id) void refreshRoutines(active.id).catch(() => undefined);
  }, [active?.id, refreshRoutines]);

  useEffect(() => {
    const messageId = searchParams.get("m");
    const routineId = searchParams.get("routine");
    if (!active) return;
    if (routineId && routinesBotId === active.id) {
      const routine = routines.find((item) => item.id === routineId);
      if (routine) {
        setRoutineDraft(draftFromRoutine(routine));
        setRoutineWebhookSecret(null);
        setEditingRoutine(routine);
        setPanel("routine");
      } else {
        setPanel(null);
      }
      const next = new URLSearchParams(searchParams);
      next.delete("routine");
      setSearchParams(next, { replace: true });
    }
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
  }, [active?.id, routines, routinesBotId, searchParams, setSearchParams, chatList.state]);
  const revealMessageRef = useRef<(messageId: string) => Promise<boolean>>(async () => false);
  const openForkRef = useRef<(target: ForkThreadTarget) => void>(() => undefined);
  // Bumps each time a turn finishes, so the Files view follows the Muse's work.
  const [filesRefreshKey, setFilesRefreshKey] = useState(0);
  // The Project folder to show in the Files tab, set by the "Working in" chip.
  const [filesReveal, setFilesReveal] = useState<{ path: string; nonce: number } | null>(null);
  const openProjectFiles = useCallback((project: ChatProject) => {
    setFilesReveal((current) => ({
      path: `projects/${project.slug}`,
      nonce: (current?.nonce ?? 0) + 1,
    }));
    setDockSheet("files");
  }, []);
  const conversationProject = useChatProject(
    active ? () => rpc.chats.project({ botId: active.id }) : undefined,
    active?.id ?? "",
    filesRefreshKey,
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
      userVisibleMessages(
        museTranscript.pendingMessage
          ? [...(museTranscript.messages ?? []), museTranscript.pendingMessage]
          : (museTranscript.messages ?? []),
        { includePeerReceipts: true },
      ),
    [museTranscript.messages, museTranscript.pendingMessage],
  );
  // An empty Conversation is a start page: the greeting, the composer centered under it, and
  // a few suggestions; the composer glides down to its dock once the first message lands.
  const startPage =
    !forksView &&
    conversationLayout({
      museMode,
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
  const { voiceStatus, setVoiceStatus, speakingMessageId, speakMessage } = useVoice({
    active,
    messages: museTranscript.messages,
    running,
    callOpen,
    activeBotId,
  });
  const callConversation = useMemo<CallConversation>(
    () => ({ messages: museTranscript.messages ?? [], running }),
    [museTranscript.messages, running],
  );
  const transcriptArtifactTarget = useMemo<ArtifactTarget>(
    () => ({ botId: active?.id ?? "" }),
    [active?.id],
  );
  const resolveTranscriptBot = useCallback(
    (botId: string) => bots.find((candidate) => candidate.id === botId),
    [bots],
  );
  const composerMentionTargets = useMemo(
    () =>
      buildComposerMentionOptions({
        query: "",
        bots: [],
        groups: [],
        routines: mentionRoutines.map((routine) => ({
          id: routine.id,
          name: routine.name,
          crons: routine.crons,
          botId: routine.botId,
          botName: routine.botName,
        })),
        connectors: mentionConnectors,
      }),
    [mentionConnectors, mentionRoutines],
  );
  const shellReady =
    initialBotsLoaded && (bots.length === 0 || Boolean(active && museTranscript.messages));

  const mentionBotsKey = useMemo(
    () => bots.map((bot) => `${bot.id}:${bot.name}`).join(","),
    [bots],
  );
  const botsForMentionsRef = useRef(bots);
  botsForMentionsRef.current = bots;

  useEffect(() => {
    const bots = botsForMentionsRef.current;
    if (!initialBotsLoaded || bots.length === 0) {
      setMentionRoutines([]);
      setMentionConnectors([]);
      return;
    }
    let cancelled = false;
    const botNameById = new Map(bots.map((bot) => [bot.id, bot.name]));
    void Promise.all(
      bots.map((bot) =>
        rpc.routines
          .list({ botId: bot.id })
          .then((rows) =>
            rows.map((routine) => ({
              ...routine,
              botName: botNameById.get(bot.id) ?? bot.name,
            })),
          )
          .catch(() => [] as Array<Routine & { botName?: string }>),
      ),
    ).then((lists) => {
      if (!cancelled) setMentionRoutines(lists.flat());
    });
    void Promise.all([
      rpc.connections.list().catch(() => [] as Connection[]),
      rpc.connections.catalog({}).catch(() => [] as ConnectionCatalogItem[]),
    ]).then(([connections, catalog]) => {
      if (cancelled) return;
      const connected = connections.filter((row) => row.status === "connected");
      const options: Array<{
        id: string;
        name: string;
        authStatus: "connected" | "needs_auth";
        connectionId?: string;
      }> = connected.map((row) => ({
        id: row.id,
        name: row.displayName,
        authStatus: "connected" as const,
        connectionId: row.id,
      }));
      for (const item of catalog) {
        if (item.connected || item.noAuth) continue;
        if (
          connected.some(
            (row) =>
              row.provider.toLowerCase() === item.slug.toLowerCase() ||
              row.displayName.toLowerCase() === item.name.toLowerCase(),
          )
        ) {
          continue;
        }
        options.push({
          id: `catalog:${item.connectorId}:${item.slug}`,
          name: item.name,
          authStatus: "needs_auth",
        });
      }
      setMentionConnectors(options);
    });
    return () => {
      cancelled = true;
    };
  }, [initialBotsLoaded, mentionBotsKey]);

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

  const { createBot } = useCreateBot({ setBots, navigate, setPanel, refreshBots });
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
  const routineEditor = useRoutineEditor({
    active,
    activeBotId,
    panel,
    setPanel,
    setBots,
    refreshRoutines,
  });
  const {
    setRoutineDraft,
    setRoutineWebhookSecret,
    setEditingRoutine,
    deleteRoutineTarget,
    setDeleteRoutineTarget,
    confirmDeleteRoutine,
  } = routineEditor;

  const userName = session.data?.user.name ?? t`You`;

  const composerEl = (
    <Composer
      key={`bot:${active?.id}`}
      museMode={museMode}
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
      onVoice={
        active
          ? () => {
              if (!voiceStatus?.ready) {
                openSettings("voice");
                return;
              }
              setCallOpen(true);
            }
          : undefined
      }
      replyTarget={replyTarget}
      replyQuote={replyQuote}
      replyTargetName={replyTargetName}
      onClearReply={clearReply}
      mentionTargets={composerMentionTargets}
      agentSkills={agentSkills}
      onSlashOpen={refreshAgentSkills}
      onSlashAction={(action) => {
        if (action === "chat-settings") {
          setPanel("settings");
          return;
        }
        if (action === "settings-general") {
          openSettings("general");
          return;
        }
        if (action === "settings-usage") {
          void rpc.usage
            .summary()
            .then(setUsage)
            .catch(() => undefined);
          openSettings("usage");
        }
      }}
    />
  );

  // The superchat top bar: the Project, the fork switch, the model and Chats.
  const superchatTopBar = active ? (
    <div className="app-drag relative z-10 flex h-[84px] min-w-0 shrink-0 items-center gap-3 ps-4 pe-4 md:ps-0 md:pe-6">
      <SuperchatLogo className="md:hidden" />
      {conversationProject ? (
        <span className="app-no-drag hidden md:inline-flex">
          <ProjectChip project={conversationProject} onOpen={openProjectFiles} />
        </span>
      ) : null}
      <span className="min-w-0 flex-1" />
      <div className="app-no-drag flex shrink-0 items-center gap-2">
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
      <ComputerUpdateProgress onCompleted={readTranscript} />
      {bootstrapMe !== undefined ? (
        <HostComputerPrompt initialMe={bootstrapMe ?? undefined} />
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
                onOpenProject={openProjectFiles}
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
                {!active && initialBotsLoaded ? (
                  <div className="grid flex-1 place-items-center">
                    <Button onClick={() => setPanel("create")}>
                      <Plus size={16} aria-hidden="true" />
                      <Trans>Create new Bot</Trans>
                    </Button>
                  </div>
                ) : forksView ? (
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
                    museMode={museMode}
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
                    onOpenPeerMessages={(peer) => {
                      setPeerConversation(peer);
                    }}
                    peerBot={resolveTranscriptBot}
                    voiceReady={Boolean(voiceStatus?.ready)}
                    speakingMessageId={speakingMessageId}
                    onSpeak={speakMessage}
                    trailing={<ApprovalCards botId={active.id} chatId={null} />}
                    onFork={forks.startAsk}
                    renderUnder={forks.renderUnder}
                    aside={
                      <ForkGutter
                        scrollRef={messageScroll}
                        messages={transcriptMessages}
                        forks={forks.rows}
                        onJump={forks.jump}
                        onLoadEarlier={
                          museTranscript.canShowEarlier
                            ? museTranscript.showEarlier
                            : museTranscript.loadOlder
                        }
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
          botName={active.name}
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
          panel && (active || panel === "create")
            ? // An inset panel like <main>.
              "w-full max-w-[400px] md:m-2 md:w-[400px] md:max-w-none"
            : "pointer-events-none w-0"
        }`}
      >
        {panel && (active || panel === "create") ? (
          <div className="rk-scroll h-full w-full overflow-y-auto px-5 py-[17px] md:w-[400px]">
            {panel !== "routine" && panel !== "create" ? (
              <SidePanelHeader panel={panel} setPanel={setPanel} active={active} />
            ) : null}
            {panel === "create" ? (
              <CreateBotForm
                onCancel={() => setPanel(null)}
                onCreate={(input) => createBot(input)}
              />
            ) : null}
            {panel === "settings" && active ? (
              <BotSettingsPanel
                active={active}
                skillsSection={<SkillsSection onSkillsChange={setAgentSkills} />}
                refreshBots={refreshBots}
                onClear={() => setClearTarget(active)}
              />
            ) : null}
            {panel === "routine" && active ? (
              <RoutinePanel
                editor={routineEditor}
                active={active}
                messagingProviders={messagingProviders}
                setPanel={setPanel}
              />
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

        {deleteRoutineTarget ? (
          <DeleteItemDialog
            item={deleteRoutineTarget}
            noun="routine"
            onCancel={() => setDeleteRoutineTarget(null)}
            onConfirm={() => confirmDeleteRoutine(deleteRoutineTarget)}
          />
        ) : null}

        <IntegrationOverlays settings={settings} activeBotId={activeBotId.current} />
      </Suspense>

      <Suspense fallback={null}>
        <SettingsHost
          settings={settings}
          userName={userName}
          email={session.data?.user.email}
          bootstrapMe={bootstrapMe}
          setBootstrapMe={setBootstrapMe}
          setVoiceStatus={setVoiceStatus}
          active={active}
          refreshBots={refreshBots}
        />
        {peerConversation && active ? (
          <PeerMessagesOverlay
            botId={active.id}
            botName={active.name}
            botColor={active.color}
            peerBotId={peerConversation.peerBotId}
            peerBotName={peerConversation.peerBotName}
            peerBotColor={
              resolveTranscriptBot(peerConversation.peerBotId)?.color ?? FALLBACK_BOT_COLOR
            }
            onClose={() => setPeerConversation(null)}
          />
        ) : null}
        {callOpen && active ? (
          <CallView
            botId={active.id}
            botName={active.name}
            transcribe={Boolean(voiceStatus?.transcribe)}
            conversation={callConversation}
            onSend={sendMessage}
            onAnswer={answerMessage}
            onClose={() => setCallOpen(false)}
          />
        ) : null}
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
