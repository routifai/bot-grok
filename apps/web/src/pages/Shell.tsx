import type {
  Bot,
  ChatSummary,
  Connection,
  ConnectionCatalogItem,
  Group,
  Routine,
  TaughtSkill,
  ThreadSnapshot,
} from "@aiden/contracts";
import {
  buildComposerMentionOptions,
  isActive,
  latestAnswerableAskMessageId,
  userVisibleMessages,
} from "@aiden/core";
import {
  AvatarStyleProvider,
  BotAvatar,
  Button,
  cn,
  GroupAvatar,
  type GroupAvatarMember,
} from "@aiden/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { Menu, Monitor, PanelRightClose, PanelRightOpen, Plus } from "lucide-react";
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
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { AppRail, type MuseRailView } from "../components/AppRail";
import { ComputerUpdateProgress } from "../components/ComputerUpdateProgress";
import { ArtifactPanelProvider } from "../components/cards/context";
import type { ArtifactTarget } from "../lib/artifact-open";
import { authClient } from "../lib/auth";
import { watchFamily } from "../lib/family-stream";
import { markAfterPaint, markOnce } from "../lib/performance";
import { rpc } from "../lib/rpc";
import { activeThreadRuns } from "../lib/thread-events";
import { memberName } from "./GroupPanel";
import { HostComputerPrompt } from "./HostComputerPrompt";
import { ApprovalCards } from "./muse/asks";
import { ContextPanel, useContextPanelCollapsed } from "./muse/chrome/ContextPanel";
import { ConversationHeader } from "./muse/chrome/ConversationHeader";
import { EmptyConversation } from "./muse/chrome/EmptyConversation";
import { MuseSidebar } from "./muse/chrome/MuseSidebar";
import { museMode } from "./muse/chrome/museMode";
import { BotSettingsPanel, GroupSettingsPanel } from "./muse/chrome/PanelForms";
import { type ChatProject, useChatProject } from "./muse/chrome/ProjectChip";
import type { Panel } from "./muse/chrome/panel";
import { SideChatSession, type SideChatWire } from "./muse/chrome/SideChatSession";
import { SidePanelHeader } from "./muse/chrome/SidePanelHeader";
import { useBotRoster } from "./muse/chrome/useBotRoster";
import { useBrowserNotifications } from "./muse/chrome/useBrowserNotifications";
import { useChatList } from "./muse/chrome/useChatList";
import { useCreateBot } from "./muse/chrome/useCreateBot";
import { useReplyAlerts } from "./muse/chrome/useReplyAlerts";
import { useVoice } from "./muse/chrome/useVoice";
import { ClearConversationHost } from "./muse/conversation/ClearConversationHost";
import { Composer } from "./muse/conversation/Composer";
import { conversationMessages as layerConversation } from "./muse/conversation/museTranscript";
import { FALLBACK_BOT_COLOR } from "./muse/conversation/shared";
import { sideChatView } from "./muse/conversation/sideChatView";
import { Transcript } from "./muse/conversation/Transcript";
import { useChatArtifacts } from "./muse/conversation/useChatArtifacts";
import { useComposerSend } from "./muse/conversation/useComposerSend";
import { useMuseTranscript } from "./muse/conversation/useMuseTranscript";
import { useThreadState } from "./muse/conversation/useThreadState";
import { useThreadSync } from "./muse/conversation/useThreadSync";
import { FeedScreen } from "./muse/FeedScreen";
import { ComputerOverlay } from "./muse/files/ComputerOverlay";
import { ComputerPreview } from "./muse/files/ComputerPreview";
import { useComputer } from "./muse/files/useComputer";
import { useComputerScreen } from "./muse/files/useComputerScreen";
import { useComputerStore } from "./muse/files/useComputerStore";
import { useComputerView } from "./muse/files/useComputerView";
import { GoalsScreen } from "./muse/GoalsScreen";
import { IdeasScreen } from "./muse/IdeasScreen";
import { LibraryScreen } from "./muse/LibraryScreen";
import { RoutineList } from "./muse/routines/RoutineList";
import { RoutinePanel } from "./muse/routines/RoutinePanel";
import { useRoutineEditor } from "./muse/routines/useRoutineEditor";
import { IntegrationOverlays } from "./muse/settings/IntegrationOverlays";
import { SettingsHost } from "./muse/settings/SettingsHost";
import { useShellSettings } from "./muse/settings/useShellSettings";
import { useAgentSkills } from "./muse/skills/useAgentSkills";
import { useTeaching } from "./muse/skills/useTeaching";
import { useMuseNav } from "./muse/useMuseNav";
import { WaitingSheet } from "./muse/WaitingSheet";
import { draftFromRoutine } from "./RoutineEditor";
import { CreateBotForm } from "./shell/bot-panel";
import { DeleteItemDialog } from "./shell/dialogs";

const PeerMessagesOverlay = lazy(() =>
  import("./PeerMessagesOverlay").then((module) => ({ default: module.PeerMessagesOverlay })),
);
const CallView = lazy(() => import("./CallView").then((module) => ({ default: module.CallView })));

/** Muse glass shell (docs/muse/DESIGN.md "Background wash"): the floating panel look
 * shared by the main content area and the Conversation column inside it — a translucent
 * panel over the ground with a 1px line. Flush edge to edge on small screens; rounded
 * once there's room for the gaps around it. */
const MUSE_GLASS_PANEL = "border border-line bg-panel backdrop-blur-xl md:rounded-[18px]";

export function ShellPage() {
  const { t } = useLingui();
  const { botId, groupId } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  // Mirrors searchParams for effects that only need to read it once on run,
  // not re-run on every unrelated query-param change (e.g. the SSE subscribe
  // effect below, which should only restart when the active bot changes).
  const searchParamsRef = useRef(searchParams);
  searchParamsRef.current = searchParams;
  const session = authClient.useSession();
  const userId = session.data?.user.id;
  const { snapshot, snapshotRef, commitSnapshot, updateSnapshot } = useThreadState();
  const computerStore = useComputerStore();
  const { computer, commitComputer } = computerStore;

  const [panel, setPanel] = useState<Panel>(null);
  const [peerConversation, setPeerConversation] = useState<{
    peerBotId: string;
    peerBotName: string;
  } | null>(null);
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [routinesBotId, setRoutinesBotId] = useState<string | null>(null);
  const [taughtSkills, setTaughtSkills] = useState<TaughtSkill[]>([]);
  const [taughtSkillsBotId, setTaughtSkillsBotId] = useState<string | null>(null);
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
  const bootstrappedThread = useRef<ThreadSnapshot | null>(null);
  const {
    bots,
    setBots,
    groups,
    setGroups,
    botsRef,
    initialBotsLoaded,
    bootstrapMe,
    setBootstrapMe,
    refreshBots,
    manuallyUnread,
    markBotReadIfVisible,
  } = useBotRoster({
    botId,
    groupId,
    navigate,
    onBootstrapThread: (thread, routines) => {
      bootstrappedThread.current = thread;
      commitSnapshot(thread);
      commitComputer(thread.computer ?? null);
      setRoutines(routines);
      setRoutinesBotId(thread.botId ?? null);
      markOnce("rk:renderer:bots-response");
      markOnce("rk:renderer:thread-response");
    },
  });

  const settings = useShellSettings(session.data?.user);
  const { messagingProviders, openSettings, setUsage } = settings;
  const [callOpen, setCallOpen] = useState(false);

  const [clearTarget, setClearTarget] = useState<
    { kind: "bot"; chat: Bot } | { kind: "group"; chat: Group } | null
  >(null);

  const inGroup = Boolean(groupId);
  const active = inGroup ? undefined : (bots.find((b) => b.id === botId) ?? bots[0]);
  const { view: museView, setView: setMuseView } = useMuseNav();
  // The open Side Chat, shown as a full-size session replacing the Conversation
  // (agreed behavior #2); "draft" is an unsent one. Cleared by navigating anywhere else.
  const [activeChat, setActiveChat] = useState<ChatSummary | "draft" | null>(null);
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
    }),
    [chatList.createSide],
  );
  const navigateMuseView = useCallback(
    (view: MuseRailView) => {
      setActiveChat(null);
      setMuseView(view);
    },
    [setMuseView],
  );
  const [contextPanelCollapsed, setContextPanelCollapsed] = useContextPanelCollapsed();
  const chatArtifacts = useChatArtifacts(
    `${active?.id ?? ""}:${activeChat === "draft" ? "draft" : (activeChat?.id ?? "")}`,
  );
  const [waitingOpen, setWaitingOpen] = useState(false);
  /** Below `md` the Muse sidebar is an off-canvas drawer opened from the main header. */
  const [navOpen, setNavOpen] = useState(false);
  const activeGroup = groups.find((group) => group.id === groupId);
  const activeRoutines = !inGroup && routinesBotId === active?.id ? routines : [];
  const activeTaughtSkills = taughtSkillsBotId === active?.id ? taughtSkills : [];
  const recordingSkill = activeTaughtSkills.find((skill) => skill.status === "recording") ?? null;
  const activeBotId = useRef<string | undefined>(inGroup ? undefined : active?.id);
  activeBotId.current = inGroup ? undefined : active?.id;
  const activeGroupId = useRef<string | undefined>(groupId);
  activeGroupId.current = groupId;
  const { flushPendingBrowserNotifications, notifyBrowserForEvent } =
    useBrowserNotifications(botsRef);
  const screen = useComputerScreen({ computerStore, activeBotId });
  const {
    scrollRequest,
    clearScrollRequest,
    messageScroll,
    loadingOlder,
    terminalRunReceipts,
    refreshThread,
    refreshGroupThread,
    refreshThreadRef,
    refreshGroupThreadRef,
    jumpToMessage,
    loadOlder,
    jumpToReplyMessage,
    scrollToMessage,
    resetThreadHistory,
  } = useThreadSync({
    target: { active, activeGroup, groupId, inGroup, activeBotId, activeGroupId },
    thread: { snapshot, snapshotRef, commitSnapshot, updateSnapshot },
    computerStore,
    screen,
    roster: { botsRef, setGroups, refreshBots, manuallyUnread, markBotReadIfVisible },
    notifyBrowserForEvent,
    lists: { setRoutines, setRoutinesBotId, setTaughtSkills, setTaughtSkillsBotId },
    searchParamsRef,
    bootstrappedThread,
  });

  useEffect(() => {
    const messageId = searchParams.get("m");
    const routineId = searchParams.get("routine");
    if (inGroup && groupId && messageId) {
      void jumpToMessage({ groupId, messageId }).finally(() => {
        // Keep expandedHistoryThread; only strip the jump URL so refresh does not remount.
        const next = new URLSearchParams(searchParams);
        next.delete("m");
        setSearchParams(next, { replace: true });
      });
      return;
    }
    if (!active) return;
    if (routineId && routinesBotId === active.id) {
      const routine = routines.find((item) => item.id === routineId);
      if (routine) {
        setRoutineDraft(draftFromRoutine(routine));
        setRoutineWebhookSecret(null);
        setEditingRoutine(routine);
        setPanel("routine");
      } else {
        setPanel("computer");
      }
      const next = new URLSearchParams(searchParams);
      next.delete("routine");
      setSearchParams(next, { replace: true });
    }
    const chatParam = searchParams.get("chat");
    if (chatParam && museMode && !inGroup) {
      // A hit in a side chat: open it (waiting for the list), then drop the jump URL.
      if (chatList.state.status === "loading") return;
      const chat =
        chatList.state.status === "ready"
          ? chatList.state.chats.find((item) => item.id === chatParam)
          : undefined;
      if (chat) {
        setActiveChat(chat);
        setMuseView("conversation");
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
      const jump =
        museMode && !inGroup
          ? revealMessageRef.current(messageId).then((found) => {
              if (found) scrollToMessage(messageId);
            })
          : jumpToMessage({ botId: active.id, messageId });
      void jump.finally(() => {
        const next = new URLSearchParams(searchParams);
        next.delete("m");
        setSearchParams(next, { replace: true });
      });
    }
  }, [
    active?.id,
    groupId,
    inGroup,
    routines,
    routinesBotId,
    searchParams,
    setSearchParams,
    chatList.state,
  ]);
  const revealMessageRef = useRef<(messageId: string) => Promise<boolean>>(async () => false);
  const activeSnapshot = inGroup
    ? snapshot?.groupId === groupId
      ? snapshot
      : null
    : snapshot?.botId === active?.id
      ? snapshot
      : null;
  const currentRuns = activeThreadRuns(activeSnapshot);
  const answerableAskMessageId = latestAnswerableAskMessageId(activeSnapshot);
  const workingRuns = currentRuns.filter((run) =>
    ["running", "queued", "leased"].includes(run.status),
  );
  const transcriptRunning = workingRuns.length > 0;
  const composerRunning = currentRuns.some((run) => isActive(run.status));
  const [computerView, setComputerView] = useComputerView();
  // Bumps each time a turn finishes, so the Files view follows the Muse's work.
  const [filesRefreshKey, setFilesRefreshKey] = useState(0);
  // The Project folder to show in the Files tab, set by the "Working in" chip.
  const [filesReveal, setFilesReveal] = useState<{ path: string; nonce: number } | null>(null);
  const openProjectFiles = useCallback(
    (project: ChatProject) => {
      setFilesReveal((current) => ({
        path: `projects/${project.slug}`,
        nonce: (current?.nonce ?? 0) + 1,
      }));
      setComputerView("files");
      setPanel("computer");
    },
    [setComputerView],
  );
  const conversationProject = useChatProject(
    active ? () => rpc.chats.project({ botId: active.id }) : undefined,
    active?.id ?? "",
    filesRefreshKey,
  );
  const wasRunningRef = useRef(false);
  useEffect(() => {
    if (wasRunningRef.current && !composerRunning) setFilesRefreshKey((key) => key + 1);
    wasRunningRef.current = composerRunning;
  }, [composerRunning]);
  // The Muse's Conversation is the engine's transcript (ADR 0009); Nova's thread only supplies
  // the person's message from the moment it is accepted until the transcript shows it. A group
  // thread is still Nova's own.
  const museTranscript = useMuseTranscript(
    museMode && !inGroup ? active?.id : undefined,
    messageScroll,
  );
  useReplyAlerts({
    bot: museMode && !inGroup ? active : undefined,
    conversationId: museTranscript.threadId,
    notifyBrowserForEvent,
    refreshBots,
  });
  const readTranscript = museTranscript.refresh;
  revealMessageRef.current = museTranscript.reveal;
  const runsKey = currentRuns.map((run) => `${run.id}:${run.status}`).join(",");
  // The engine records the person's message when a run starts and the reply when it ends, and
  // the stream only announces replies: read again on each run change.
  const seenRunsKey = useRef(runsKey);
  useEffect(() => {
    if (seenRunsKey.current === runsKey) return;
    seenRunsKey.current = runsKey;
    readTranscript();
  }, [runsKey, readTranscript]);
  const conversationMessages = useMemo(() => {
    const fromEngine = museTranscript.messages;
    if (!museMode || inGroup) return activeSnapshot?.messages ?? [];
    if (!fromEngine) return [];
    return layerConversation(fromEngine, activeSnapshot?.messages ?? []);
  }, [museTranscript.messages, inGroup, activeSnapshot?.messages]);
  const transcriptMessages = useMemo(
    () => userVisibleMessages(conversationMessages, { includePeerReceipts: true }),
    [conversationMessages],
  );
  // What voice (auto-speak, calls) reads the reply from.
  const conversationSnapshot = useMemo(
    () => (activeSnapshot ? { ...activeSnapshot, messages: conversationMessages } : null),
    [activeSnapshot, conversationMessages],
  );
  const { voiceStatus, setVoiceStatus, speakingMessageId, speakMessage } = useVoice({
    active,
    snapshot: conversationSnapshot,
    callOpen,
    activeBotId,
  });
  const transcriptArtifactTarget = useMemo<ArtifactTarget>(
    () => (inGroup ? { groupId: groupId ?? "" } : { botId: active?.id ?? "" }),
    [active?.id, groupId, inGroup],
  );
  const transcriptMembers = activeSnapshot?.members ?? activeGroup?.members;
  const resolveTranscriptBot = useCallback(
    (botId: string) => {
      const bot = bots.find((candidate) => candidate.id === botId);
      if (bot) return bot;
      return transcriptMembers?.find((member) => member.botId === botId);
    },
    [bots, transcriptMembers],
  );
  const workingBots: GroupAvatarMember[] = workingRuns.map((run) => {
    const bot = resolveTranscriptBot(run.botId);
    return {
      botId: run.botId,
      color: bot?.color ?? FALLBACK_BOT_COLOR,
      name: bot?.name,
      status: run.status,
    };
  });
  const resolveTranscriptMemberName = useCallback(
    (botId: string | undefined) => memberName(transcriptMembers, botId),
    [transcriptMembers],
  );
  const composerMentionTargets = useMemo(
    () =>
      buildComposerMentionOptions({
        query: "",
        includeEveryone: inGroup,
        currentGroupId: groupId,
        bots: bots.map((bot) => ({ id: bot.id, name: bot.name, color: bot.color })),
        groups: groups.map((group) => ({ id: group.id, name: group.name })),
        routines: mentionRoutines.map((routine) => ({
          id: routine.id,
          name: routine.name,
          crons: routine.crons,
          botId: routine.botId,
          botName: routine.botName,
        })),
        connectors: mentionConnectors,
      }),
    [bots, groupId, groups, inGroup, mentionConnectors, mentionRoutines],
  );
  const shellReady =
    initialBotsLoaded &&
    (inGroup
      ? Boolean(activeGroup && activeSnapshot)
      : bots.length === 0 || Boolean(active && activeSnapshot));

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
    if (active && snapshot?.botId === active.id) {
      markOnce("rk:renderer:thread-committed");
      markAfterPaint("rk:renderer:thread-painted");
    }
    if (shellReady) {
      markOnce("rk:renderer:shell-ready");
      markAfterPaint("rk:renderer:shell-painted");
    }
  }, [active, initialBotsLoaded, shellReady, snapshot?.botId]);

  const openBot = useCallback((id: string) => navigate(`/app/${id}`), [navigate]);
  const { createBot, cancelFocusPrompt, focusPromptBotIdRef } = useCreateBot({
    botsRef,
    setBots,
    navigate,
    setPanel,
    refreshBots,
    activeBotId,
    activeId: active?.id,
  });
  const {
    activePendingAttachments,
    setReplyTarget,
    setReplyQuote,
    activeReplyTarget,
    activeReplyQuote,
    clearReply,
    sending,
    sendError,
    composerSeed,
    setComposerSeed,
    attachmentNotice,
    fileInputRef,
    followSignal,
    displayedRunError,
    displayedRunErrorId,
    handleRunErrorPresented,
    dismissComposerError,
    answerMessage,
    reactToMessage,
    onAttachmentPick,
    removeAttachment,
    sendMessage,
    sendCardReply,
    followUpMessage,
    stopRun,
  } = useComposerSend({
    target: { active, groupId, inGroup, activeBotId, activeGroupId },
    userId,
    museMode,
    activeSnapshot,
    threadOps: { terminalRunReceipts, refreshThreadRef, refreshGroupThreadRef, updateSnapshot },
    roster: { botsRef, refreshBots },
    flushPendingBrowserNotifications,
    computerStore,
    focusPrompt: { cancelFocusPrompt, focusPromptBotIdRef },
  });
  const replyTargetName = activeReplyTarget
    ? activeReplyTarget.role === "user"
      ? t`You`
      : (resolveTranscriptMemberName(activeReplyTarget.botId) ?? active?.name ?? t`Bot`)
    : undefined;
  const handleSendIdea = useCallback(
    (text: string) => {
      setMuseView("conversation");
      void sendMessage(text);
    },
    [sendMessage, setMuseView],
  );
  const computerCtl = useComputer({
    target: { active, bots, botsRef, activeBotId, activeGroupId },
    panel,
    computerStore,
    screen,
    thread: { snapshot, refreshThread, refreshThreadRef, refreshGroupThreadRef },
  });
  const { onOpenComputer, setComputerOpen } = computerCtl;
  const { teachBusy, stopTeaching, refreshActiveTeaching } = useTeaching({
    activeBotId,
    taughtSkills,
    taughtSkillsBotId,
    setTaughtSkills,
    setTaughtSkillsBotId,
    refreshThreadRef,
    setComputerOpen,
  });
  // Transcript and MessageView are memoized; these must stay referentially stable or every
  // Shell state change re-renders the whole transcript.
  const refreshActiveThread = useCallback(async () => {
    const groupId = activeGroupId.current;
    if (groupId) {
      await refreshGroupThreadRef.current(groupId);
      return;
    }
    const id = activeBotId.current;
    if (!id) return;
    await refreshThreadRef.current(id);
  }, []);
  const routineEditor = useRoutineEditor({
    active,
    activeBotId,
    panel,
    setPanel,
    setBots,
    refreshThread,
  });
  const {
    setRoutineDraft,
    setRoutineWebhookSecret,
    setEditingRoutine,
    deleteRoutineTarget,
    setDeleteRoutineTarget,
    confirmDeleteRoutine,
    addSkillRoutine,
  } = routineEditor;

  const userName = session.data?.user.name ?? t`You`;

  const shell = (
    <div
      data-testid="shell-root"
      data-ready={shellReady}
      className={
        museMode
          ? "muse-wash relative flex h-full min-w-0 overflow-hidden text-foreground md:gap-3 md:p-3"
          : "relative flex h-full min-w-0 overflow-hidden bg-background text-foreground/90"
      }
    >
      <ComputerUpdateProgress
        onCompleted={() => {
          if (active) void refreshThread(active.id);
        }}
      />
      {bootstrapMe !== undefined ? (
        <HostComputerPrompt initialMe={bootstrapMe ?? undefined} />
      ) : null}
      {active ? (
        <MuseSidebar
          botId={active.id}
          runs={currentRuns}
          messages={activeSnapshot?.messages}
          personName={bootstrapMe?.name}
          active={museView}
          activeChatId={activeChat === "draft" ? "draft" : (activeChat?.id ?? null)}
          chatListState={chatList.state}
          onNavigate={navigateMuseView}
          onOpenWaiting={() => setWaitingOpen(true)}
          onOpenSettings={() => openSettings("general")}
          onOpenChat={(chat) => {
            setActiveChat(chat);
            setMuseView("conversation");
          }}
          onNewDraft={() => {
            setActiveChat("draft");
            setMuseView("conversation");
          }}
          mobileOpen={navOpen}
          onMobileOpenChange={setNavOpen}
        />
      ) : (
        <AppRail active="bots" />
      )}

      <main
        className={
          museMode
            ? "relative z-10 flex min-w-0 flex-1 flex-col"
            : "flex min-w-0 flex-1 flex-col bg-background"
        }
      >
        {museMode && active ? (
          <div className="flex h-12 shrink-0 items-center gap-2 px-3 md:hidden">
            <button
              type="button"
              data-testid="mobile-nav-trigger"
              title={t`Menu`}
              aria-label={t`Menu`}
              onClick={() => setNavOpen(true)}
              className="grid size-9 place-items-center rounded-full text-foreground/80 transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
            >
              <Menu size={20} strokeWidth={1.75} />
            </button>
            <span className="min-w-0 truncate text-[15px] font-medium" dir="auto">
              {activeChat
                ? t`Side chat`
                : museView === "goals"
                  ? t`Goals`
                  : museView === "feed"
                    ? t`Feed`
                    : museView === "ideas"
                      ? t`Ideas`
                      : museView === "library"
                        ? t`Library`
                        : t`Conversation`}
            </span>
          </div>
        ) : null}
        {museMode && active && museView === "conversation" && activeChat ? (
          <div className="flex min-h-0 flex-1 gap-0 md:gap-3">
            <div
              className={cn(
                "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
                MUSE_GLASS_PANEL,
              )}
            >
              <SideChatSession
                chat={activeChat}
                bot={{ id: active.id, name: active.name, color: active.color }}
                view={sideChatView}
                wire={sideChatWire}
                onCreated={setActiveChat}
                onReplied={chatList.refresh}
                onClose={() => setActiveChat(null)}
                onOpenProject={openProjectFiles}
                focusMessageId={
                  activeChat !== "draft" && chatFocus?.chatId === activeChat.id
                    ? chatFocus.messageId
                    : undefined
                }
              />
            </div>
            {chatArtifacts.panel}
          </div>
        ) : museMode && active && museView !== "conversation" ? (
          <div
            className={cn(
              "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
              MUSE_GLASS_PANEL,
            )}
          >
            {museView === "goals" ? (
              <GoalsScreen
                botId={active.id}
                botName={active.name}
                avatarColor={active.color}
                onSendIdea={handleSendIdea}
              />
            ) : museView === "feed" ? (
              <FeedScreen
                botId={active.id}
                botName={active.name}
                avatarColor={active.color}
                onSendIdea={handleSendIdea}
              />
            ) : museView === "ideas" ? (
              <IdeasScreen
                botId={active.id}
                onSendIdea={handleSendIdea}
                onOpenConversation={() => setMuseView("conversation")}
              />
            ) : (
              <LibraryScreen
                botId={active.id}
                botName={active.name}
                avatarColor={active.color}
                onSendIdea={handleSendIdea}
              />
            )}
          </div>
        ) : (
          <div className={museMode && active ? "flex min-h-0 flex-1 gap-0 md:gap-3" : "contents"}>
            <div
              className={
                museMode && active
                  ? cn(
                      "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
                      MUSE_GLASS_PANEL,
                    )
                  : "contents"
              }
            >
              {museMode && active ? (
                <ConversationHeader
                  botId={active.id}
                  museName={active.name}
                  color={active.color}
                  runs={currentRuns}
                  messages={activeSnapshot?.messages}
                  // Same condition as the context panel's own `collapsed` below: whenever
                  // its identity header isn't visible (collapsed, a side panel open, or
                  // below `xl`), this header's compact identity covers it instead.
                  identityCollapsed={contextPanelCollapsed || panel !== null}
                  onOpenWaiting={() => setWaitingOpen(true)}
                  project={conversationProject}
                  onOpenProject={openProjectFiles}
                  actions={
                    <>
                      <button
                        type="button"
                        title={
                          contextPanelCollapsed ? t`Show context panel` : t`Hide context panel`
                        }
                        aria-label={
                          contextPanelCollapsed ? t`Show context panel` : t`Hide context panel`
                        }
                        aria-pressed={!contextPanelCollapsed}
                        onClick={() => setContextPanelCollapsed(!contextPanelCollapsed)}
                        className="hidden size-9 items-center justify-center rounded-full text-ink-2 transition-colors hover:bg-selection hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring xl:grid"
                      >
                        {contextPanelCollapsed ? (
                          <PanelRightOpen size={17} strokeWidth={1.75} />
                        ) : (
                          <PanelRightClose size={17} strokeWidth={1.75} />
                        )}
                      </button>
                      <button
                        type="button"
                        title={t`Agent computer`}
                        aria-label={t`Agent computer`}
                        onClick={() => {
                          const next = panel === "computer" ? null : "computer";
                          setPanel(next);
                          if (next === "computer") {
                            // Refresh run/computer so Take control isn't stuck on a stale busyBotName.
                            void refreshThread(active.id).catch(() => undefined);
                          }
                        }}
                        data-active={panel === "computer" ? "" : undefined}
                        className="grid size-9 place-items-center rounded-full text-ink-2 transition-colors hover:bg-selection hover:text-foreground data-active:bg-selection data-active:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                      >
                        <Monitor size={17} strokeWidth={1.75} />
                      </button>
                    </>
                  }
                />
              ) : (
                <div className="app-drag flex items-center justify-between border-b border-sidebar-border px-3 py-[17px] md:px-[22px]">
                  <div className="flex min-w-0 items-center gap-2">
                    <button
                      type="button"
                      data-testid="bot-settings-trigger"
                      onClick={() => setPanel(inGroup ? "group-settings" : "settings")}
                      className="app-no-drag flex min-w-0 items-center gap-3"
                    >
                      {inGroup ? (
                        <GroupAvatar
                          members={activeSnapshot?.members ?? activeGroup?.members ?? []}
                          size={26}
                        />
                      ) : active ? (
                        <BotAvatar
                          color={active.color}
                          identity={active.id}
                          size={26}
                          status={active.status}
                          face={museMode ? "muse" : undefined}
                        />
                      ) : null}
                      <span className="min-w-0">
                        <span
                          className="block truncate text-[16px] font-medium text-foreground"
                          dir="auto"
                        >
                          {inGroup
                            ? (activeGroup?.name ?? activeSnapshot?.groupName ?? t`Group`)
                            : (active?.name ?? t`Select a bot`)}
                        </span>
                      </span>
                    </button>
                  </div>
                  <div className="flex items-center gap-1">
                    {!inGroup && active ? (
                      <button
                        type="button"
                        title={t`Agent computer`}
                        onClick={() => {
                          const next = panel === "computer" ? null : "computer";
                          setPanel(next);
                          if (next === "computer" && active) {
                            // Refresh run/computer so Take control isn't stuck on a stale busyBotName.
                            void refreshThread(active.id).catch(() => undefined);
                          }
                        }}
                        data-active={panel === "computer" ? "" : undefined}
                        className="app-no-drag grid h-[30px] w-[34px] place-items-center rounded-[9px] hover:bg-accent data-active:bg-accent"
                      >
                        <Monitor size={18} strokeWidth={1.6} className="text-foreground/75" />
                      </button>
                    ) : null}
                  </div>
                </div>
              )}
              {!active && !activeGroup && initialBotsLoaded ? (
                <div className="grid flex-1 place-items-center">
                  <Button onClick={() => setPanel("create")}>
                    <Plus size={16} aria-hidden="true" />
                    <Trans>Create new Bot</Trans>
                  </Button>
                </div>
              ) : museMode &&
                active &&
                museTranscript.messages !== null &&
                transcriptMessages.length === 0 &&
                !transcriptRunning ? (
                <EmptyConversation
                  botName={active.name}
                  personName={bootstrapMe?.name ?? ""}
                  avatarColor={active.color}
                  onSend={(text) => void sendMessage(text)}
                  onTryIt={setComposerSeed}
                />
              ) : (
                <Transcript
                  key={activeSnapshot?.threadId}
                  museMode={museMode}
                  botDisplayName={active?.name}
                  followSignal={followSignal}
                  museFace={active ? { color: active.color, identity: active.id } : undefined}
                  museRuns={currentRuns}
                  scrollRef={messageScroll}
                  scrollRequest={scrollRequest}
                  onScrollRequestHandled={clearScrollRequest}
                  artifactTarget={transcriptArtifactTarget}
                  messages={transcriptMessages}
                  olderCursor={
                    museMode && !inGroup
                      ? museTranscript.olderCursor
                      : (activeSnapshot?.olderCursor ?? null)
                  }
                  loadingOlder={museMode && !inGroup ? museTranscript.loadingOlder : loadingOlder}
                  answerableAskMessageId={answerableAskMessageId}
                  running={transcriptRunning}
                  workingBots={workingBots}
                  onLoadOlder={museMode && !inGroup ? museTranscript.loadOlder : loadOlder}
                  onShowEarlier={
                    museMode && !inGroup && museTranscript.canShowEarlier
                      ? museTranscript.showEarlier
                      : undefined
                  }
                  onOpenBot={openBot}
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
                  onReact={reactToMessage}
                  onJumpToMessage={jumpToReplyMessage}
                  onOpenPeerMessages={(peer) => {
                    setPeerConversation(peer);
                  }}
                  memberName={resolveTranscriptMemberName}
                  peerBot={resolveTranscriptBot}
                  onRefresh={refreshActiveThread}
                  onBotChanged={refreshBots}
                  onAddRoutine={addSkillRoutine}
                  voiceReady={Boolean(voiceStatus?.ready)}
                  speakingMessageId={speakingMessageId}
                  onSpeak={speakMessage}
                  onOpenComputer={onOpenComputer}
                  trailing={
                    museMode && active ? (
                      <ApprovalCards botId={active.id} chatId={null} />
                    ) : undefined
                  }
                />
              )}
              {recordingSkill ? (
                <div className="px-6 pb-2 text-center text-[13px] text-destructive">
                  <Trans>Teaching in progress. Stop teaching before sending a new message.</Trans>
                </div>
              ) : null}
              {active || activeGroup ? (
                <Composer
                  key={inGroup ? `group:${groupId}` : `bot:${active?.id}`}
                  museMode={museMode}
                  activeName={
                    inGroup ? (activeGroup?.name ?? activeSnapshot?.groupName) : active?.name
                  }
                  running={composerRunning}
                  disabled={Boolean(recordingSkill)}
                  pendingAttachments={activePendingAttachments}
                  attachmentNotice={attachmentNotice}
                  sendError={sendError}
                  runError={displayedRunError}
                  runErrorId={displayedRunErrorId}
                  onRunErrorPresented={handleRunErrorPresented}
                  onDismissError={dismissComposerError}
                  sending={sending}
                  fileInputRef={fileInputRef}
                  onAttachmentPick={onAttachmentPick}
                  onRemoveAttachment={removeAttachment}
                  onSend={sendMessage}
                  seedText={composerSeed}
                  onSeedConsumed={() => setComposerSeed(null)}
                  onStop={stopRun}
                  onVoice={
                    !inGroup && active
                      ? () => {
                          if (!voiceStatus?.ready) {
                            openSettings("voice");
                            return;
                          }
                          setCallOpen(true);
                        }
                      : undefined
                  }
                  replyTarget={activeReplyTarget}
                  replyQuote={activeReplyQuote}
                  replyTargetName={replyTargetName}
                  onClearReply={clearReply}
                  mentionTargets={composerMentionTargets}
                  agentSkills={agentSkills}
                  onSlashOpen={refreshAgentSkills}
                  onSlashAction={(action) => {
                    if (action === "chat-settings") {
                      setPanel(inGroup ? "group-settings" : "settings");
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
              ) : null}
            </div>
            {museMode && active ? chatArtifacts.panel : null}
            {museMode && active ? (
              <ContextPanel
                botId={active.id}
                museName={active.name}
                avatarColor={active.color}
                chatListState={chatList.state}
                // The computer (or settings) side panel takes that column; two side panels
                // would crush the conversation.
                collapsed={contextPanelCollapsed || panel !== null || chatArtifacts.isOpen}
                onNavigate={navigateMuseView}
                onOpenWaiting={() => setWaitingOpen(true)}
              />
            ) : null}
          </div>
        )}
      </main>

      {museMode && active ? (
        <WaitingSheet
          botId={active.id}
          avatarColor={active.color}
          open={waitingOpen}
          onOpenChange={setWaitingOpen}
        />
      ) : null}

      <aside
        data-testid="side-panel"
        data-panel={panel ?? "closed"}
        className={`absolute inset-y-0 end-0 z-20 flex min-h-0 shrink-0 flex-col overflow-hidden transition-[width] duration-150 ease-out md:relative ${
          museMode ? "border-line bg-panel backdrop-blur-xl" : "bg-background"
        } ${
          panel && (active || activeGroup || panel === "create")
            ? museMode
              ? // Muse: an inset panel like <main>; the computer gets room for a real preview.
                `w-full md:rounded-[18px] md:border ${
                  panel === "computer"
                    ? "max-w-[520px] md:w-[520px] md:max-w-none"
                    : "max-w-[400px] md:w-[400px] md:max-w-none"
                }`
              : "w-full max-w-[384px] border-s border-sidebar-border md:w-[384px] md:max-w-none"
            : "pointer-events-none w-0"
        }`}
      >
        {panel && (active || activeGroup || panel === "create") ? (
          <div
            className={`rk-scroll h-full w-full overflow-y-auto px-5 py-[17px] ${
              museMode ? (panel === "computer" ? "md:w-[520px]" : "md:w-[400px]") : "md:w-[384px]"
            }`}
          >
            {panel !== "routine" && panel !== "create" && panel !== "group-settings" ? (
              <SidePanelHeader
                panel={panel}
                setPanel={setPanel}
                active={active}
                computer={computer}
                ctl={computerCtl}
                screen={screen}
                computerView={computerView}
                setComputerView={setComputerView}
                refreshThread={refreshThread}
              />
            ) : null}
            {panel === "computer" && active ? (
              <ComputerPreview
                active={active}
                computer={computer}
                ctl={computerCtl}
                screen={screen}
                computerView={computerView}
                filesRefreshKey={filesRefreshKey}
                filesReveal={filesReveal}
                sandboxProvider={bootstrapMe?.sandboxProvider}
              >
                <RoutineList
                  routines={activeRoutines}
                  run={snapshot?.run}
                  onCreate={routineEditor.openNew}
                  onOpen={routineEditor.openRoutine}
                  onStop={() => void stopRun()}
                />
              </ComputerPreview>
            ) : null}
            {panel === "group-settings" && activeGroup ? (
              <GroupSettingsPanel
                activeGroup={activeGroup}
                bots={bots}
                groups={groups}
                setGroups={setGroups}
                setPanel={setPanel}
                refreshBots={refreshBots}
                refreshGroupThread={refreshGroupThread}
              />
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
                setAgentSkills={setAgentSkills}
                refreshBots={refreshBots}
                onClear={() => setClearTarget({ kind: "bot", chat: active })}
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
            clearTarget={clearTarget}
            onClose={() => setClearTarget(null)}
            active={active}
            activeGroup={activeGroup}
            resetThreadHistory={resetThreadHistory}
            updateSnapshot={updateSnapshot}
            refreshBots={refreshBots}
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
            snapshot={conversationSnapshot}
            onSend={sendMessage}
            onFollowUp={followUpMessage}
            onAnswer={answerMessage}
            onClose={() => setCallOpen(false)}
          />
        ) : null}
      </Suspense>

      <ComputerOverlay
        active={active}
        computer={computer}
        ctl={computerCtl}
        screen={screen}
        teach={{ recordingSkill, teachBusy, stopTeaching, refreshActiveTeaching }}
        run={{ currentRuns, composerRunning, sending, sendError, stopRun }}
      />
    </div>
  );

  return (
    <AvatarStyleProvider value={bootstrapMe?.avatarStyle ?? "robot"}>
      <ArtifactPanelProvider value={chatArtifacts.api}>{shell}</ArtifactPanelProvider>
    </AvatarStyleProvider>
  );
}
