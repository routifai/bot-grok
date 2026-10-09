import { useLingui } from "@lingui/react/macro";
import type { Bot, ThreadMessage, ThreadSnapshot, WorkspaceAttachment } from "@nova/contracts";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_COUNT, type MessageReaction } from "@nova/contracts";
import {
  attachmentsForThread,
  type ComposerMention,
  inferAttachmentMimeType,
  isIngestableAttachmentMimeType,
  resolveComposerSendPlan,
} from "@nova/core";
import { ORPCError } from "@orpc/client";
import { type MutableRefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { notifyAsksChanged } from "../../../features/approvals";
import type { useComputerStore } from "../../../features/computer/useComputerStore";
import { requestBrowserNotificationPermission } from "../../../lib/browser-notifications";
import { newClientId } from "../../../lib/client-id";
import { revokePendingAttachmentPreviews } from "../../../lib/pending-attachments";
import { rpc } from "../../../lib/rpc";
import { readSeenRunErrorIds, rememberSeenRunErrorId } from "../../../lib/run-error-storage";
import {
  applyThreadSendReceipt,
  clearActiveThreadRuns,
  threadRunError,
} from "../../../lib/thread-events";
import { isRawEngineError, userFacingError } from "../../../lib/user-facing-error";
import type { useCreateBot } from "../chrome/useCreateBot";
import { markFirstRunSeen } from "../intro";
import { type ComputerFeed, followComputerStart, runWhenComputerReady } from "./computerReady";
import { quotedMessageText } from "./museTranscript";
import { attachmentsBlockSend, type PendingAttachment, readFileAsBase64 } from "./shared";
import type { useThreadState } from "./useThreadState";
import type { useThreadSync } from "./useThreadSync";

/** The Computer is asleep and still waking: the upload could not land yet. */
function isComputerStarting(error: unknown): boolean {
  return error instanceof ORPCError && error.code === "SERVICE_UNAVAILABLE";
}

/** The Computer is awake but did not finish reading the file in time (not "starting"). */
function isReadTimeout(error: unknown): boolean {
  return error instanceof ORPCError && error.code === "GATEWAY_TIMEOUT";
}

/** The composer's side of a conversation: attachments, replies, sending, stopping, answering
 * asks and reacting to messages. */
export function useComposerSend({
  target,
  userId,
  museMode,
  activeSnapshot,
  threadOps,
  roster,
  flushPendingBrowserNotifications,
  computerStore,
  focusPrompt,
}: {
  target: {
    active: Bot | undefined;
    groupId: string | undefined;
    inGroup: boolean;
    activeBotId: MutableRefObject<string | undefined>;
    activeGroupId: MutableRefObject<string | undefined>;
  };
  userId: string | undefined;
  museMode: boolean;
  activeSnapshot: ThreadSnapshot | null;
  threadOps: Pick<
    ReturnType<typeof useThreadSync>,
    "terminalRunReceipts" | "refreshThreadRef" | "refreshGroupThreadRef"
  > &
    Pick<ReturnType<typeof useThreadState>, "updateSnapshot">;
  roster: {
    botsRef: MutableRefObject<Bot[]>;
    refreshBots: (includeArchived?: boolean) => Promise<void>;
  };
  flushPendingBrowserNotifications: () => void;
  computerStore: Pick<
    ReturnType<typeof useComputerStore>,
    "computerRef" | "commitComputer" | "onComputerChange"
  >;
  focusPrompt: Pick<ReturnType<typeof useCreateBot>, "cancelFocusPrompt" | "focusPromptBotIdRef">;
}) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const { active, groupId, inGroup, activeBotId, activeGroupId } = target;
  const { terminalRunReceipts, refreshThreadRef, refreshGroupThreadRef, updateSnapshot } =
    threadOps;
  const { botsRef, refreshBots } = roster;
  const { computerRef, commitComputer, onComputerChange } = computerStore;
  const computerFeed = useMemo<ComputerFeed>(
    () => ({ current: () => computerRef.current, subscribe: onComputerChange }),
    [computerRef, onComputerChange],
  );
  const { cancelFocusPrompt, focusPromptBotIdRef } = focusPrompt;
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const pendingRef = useRef<PendingAttachment[]>([]);
  pendingRef.current = pendingAttachments;
  const [replyTarget, setReplyTarget] = useState<ThreadMessage | null>(null);
  const [replyQuote, setReplyQuote] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // First-run "Try it" chips (muse/intro/FirstRunWelcome.tsx) fill the composer with the
  // example rather than sending it, so the person sees it before it goes out.
  const [composerSeed, setComposerSeed] = useState<string | null>(null);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  // Files already written to the workspace, by pending id: a retry after a failed send does not
  // upload them twice.
  const uploadedRef = useRef(new Map<string, WorkspaceAttachment>());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dismissedRunErrorIds, setDismissedRunErrorIds] =
    useState<ReadonlySet<string>>(readSeenRunErrorIds);
  /** Bumped on every send so the transcript jumps to the bottom and follows the reply. */
  const [followSignal, setFollowSignal] = useState(0);
  const activePendingAttachments = useMemo(
    () => attachmentsForThread(pendingAttachments, inGroup ? groupId : active?.id),
    [active?.id, groupId, inGroup, pendingAttachments],
  );
  // Keep the armed reply even when its parent leaves the loaded page: the
  // server resolves a paged-out target and degrades a deleted one to a plain
  // reply instead of failing the send.
  const activeReplyTarget = replyTarget;
  const activeReplyQuote = replyTarget ? replyQuote : null;
  const clearReply = useCallback(() => {
    setReplyTarget(null);
    setReplyQuote(null);
  }, []);
  const runError = threadRunError(activeSnapshot, dismissedRunErrorIds);
  // A run that failed before the API hid engine detail may still carry a raw status line.
  const displayedRunError = sendError
    ? null
    : runError && isRawEngineError(runError)
      ? t`Nova couldn't start. Try again in a moment.`
      : runError;
  const displayedRunErrorId = displayedRunError ? (activeSnapshot?.run?.id ?? null) : null;
  const handleRunErrorPresented = useCallback((runId: string) => {
    rememberSeenRunErrorId(runId);
  }, []);
  const answerMessage = useCallback(
    async (message: ThreadMessage, text: string, username?: string) => {
      const botId = activeBotId.current;
      const groupId = activeGroupId.current;
      if (!botId && !groupId) return;
      if (museMode && botId) {
        // Muse Asks (Proposals, blocked Tasks, skill offers) apply their own effect; asks.answer
        // routes each kind and falls back to the run-input path for ordinary questions.
        await rpc.asks.answer({
          askId: message.id,
          runId: message.runId ?? "",
          answer: text,
          ...(username ? { username } : {}),
        });
        notifyAsksChanged(botId);
      } else {
        await rpc.threads.answer({
          ...(groupId ? { groupId } : { botId: botId! }),
          runId: message.runId ?? "",
          messageId: message.id,
          answer: text,
          ...(username ? { username } : {}),
        });
      }
      if (groupId && activeGroupId.current === groupId) {
        await refreshGroupThreadRef.current(groupId);
      } else if (botId && activeBotId.current === botId) {
        await refreshThreadRef.current(botId);
      }
    },
    [museMode],
  );
  const reactToMessage = useCallback(
    async (message: ThreadMessage, reaction: MessageReaction) => {
      const botId = activeBotId.current;
      const groupId = activeGroupId.current;
      if (!botId && !groupId) return;
      try {
        await rpc.threads.react({
          ...(groupId ? { groupId } : { botId: botId! }),
          messageId: message.id,
          reaction,
          clientNonce: newClientId(),
        });
      } catch (error) {
        const stillHere = groupId
          ? activeGroupId.current === groupId
          : activeBotId.current === botId;
        if (!stillHere) return;
        setSendError(userFacingError(error, t`Could not update reaction`));
      }
    },
    [t],
  );
  const setAttachmentState = useCallback(
    (id: string, status: PendingAttachment["status"], error?: string) =>
      setPendingAttachments((current) =>
        current.map((item) =>
          item.id === id
            ? { ...item, status, error: status === "error" ? error : undefined }
            : item,
        ),
      ),
    [],
  );
  // One AbortController per attachment still being prepared: removing the chip, leaving the chat
  // or closing the page cancels its wait for the Computer and its read.
  const controllersRef = useRef(new Map<string, AbortController>());
  // The send-time upload (a file picked without a chip read) is cancelled when the page goes.
  const sendAbort = useRef(new AbortController());
  useEffect(() => {
    const controller = sendAbort.current;
    return () => controller.abort();
  }, []);
  const abortAttachment = useCallback((id: string) => {
    controllersRef.current.get(id)?.abort();
    controllersRef.current.delete(id);
  }, []);
  useEffect(() => {
    const controllers = controllersRef.current;
    return () => {
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
    };
  }, []);
  /** A Muse attachment is written to the Computer and read there as soon as it is picked, so its
   * text is ready before the message goes (uploading, reading, ready, or a calm error). A sleeping
   * Computer is waited for by its status events (the chip says so), never by a retry timer. */
  const prepareAttachment = useCallback(
    async (attachment: PendingAttachment, botId: string) => {
      const mimeType = inferAttachmentMimeType(attachment.file.name, attachment.file.type);
      if (!mimeType) return;
      abortAttachment(attachment.id);
      const controller = new AbortController();
      controllersRef.current.set(attachment.id, controller);
      const { signal } = controller;
      let unfollow: (() => void) | undefined;
      try {
        let stored = uploadedRef.current.get(attachment.id);
        if (!stored) {
          setAttachmentState(attachment.id, "uploading");
          const contentBase64 = await readFileAsBase64(attachment.file);
          signal.throwIfAborted();
          stored = await runWhenComputerReady(
            () =>
              rpc.files.uploadAttachment(
                { botId, name: attachment.file.name, mimeType, contentBase64 },
                { signal },
              ),
            {
              isStarting: isComputerStarting,
              onStarting: () => setAttachmentState(attachment.id, "starting"),
              feed: computerFeed,
              signal,
            },
          );
          uploadedRef.current.set(attachment.id, stored);
        }
        if (isIngestableAttachmentMimeType(mimeType)) {
          const path = stored.path;
          setAttachmentState(attachment.id, "reading");
          // One call: the engine wakes the Computer and waits for the read. The chip follows the
          // Computer's own status while it does.
          unfollow = followComputerStart(computerFeed, {
            onStarting: () => setAttachmentState(attachment.id, "starting"),
            onUp: () => setAttachmentState(attachment.id, "reading"),
          });
          await rpc.files.ingestAttachment({ botId, path }, { signal });
          unfollow();
          unfollow = undefined;
        }
        setAttachmentState(attachment.id, "ready");
      } catch (error) {
        if (signal.aborted) return; // the chip is gone, or the person left: nothing to report
        setAttachmentState(
          attachment.id,
          "error",
          isComputerStarting(error)
            ? t`Your Computer is starting. Try again in a moment.`
            : isReadTimeout(error)
              ? t`Reading ${attachment.file.name} is taking too long. Try again in a moment.`
              : userFacingError(error, t`Couldn't read ${attachment.file.name}`),
        );
      } finally {
        unfollow?.();
        if (controllersRef.current.get(attachment.id) === controller) {
          controllersRef.current.delete(attachment.id);
        }
      }
    },
    [abortAttachment, computerFeed, setAttachmentState, t],
  );
  const retryAttachment = useCallback(
    (attachment: PendingAttachment) => {
      const botId = activeBotId.current;
      if (botId) void prepareAttachment(attachment, botId);
    },
    [prepareAttachment],
  );
  const onAttachmentPick = useCallback(
    async (files: FileList | null) => {
      const threadKey = activeGroupId.current ?? activeBotId.current;
      if (!threadKey || !files?.length) return;
      const existing = attachmentsForThread(pendingAttachments, threadKey);
      const toWorkspace = Boolean(museMode && activeBotId.current && !activeGroupId.current);
      const next: PendingAttachment[] = [];
      const skipped: string[] = [];
      for (const file of Array.from(files)) {
        if (existing.length + next.length >= ATTACHMENT_MAX_COUNT) {
          skipped.push(t`${file.name} (max ${ATTACHMENT_MAX_COUNT} attachments)`);
          continue;
        }
        if (file.size > ATTACHMENT_MAX_BYTES) {
          skipped.push(t`${file.name} (over 10 MiB)`);
          continue;
        }
        const mimeType = inferAttachmentMimeType(file.name, file.type);
        if (!mimeType) {
          skipped.push(file.name);
          continue;
        }
        next.push({
          id: newClientId(),
          threadKey,
          file,
          previewUrl: mimeType.startsWith("image/") ? URL.createObjectURL(file) : undefined,
          ...(toWorkspace ? { status: "uploading" as const } : {}),
        });
      }
      if (next.length) setPendingAttachments((current) => [...current, ...next]);
      if (toWorkspace && activeBotId.current) {
        for (const item of next) void prepareAttachment(item, activeBotId.current);
      }
      setAttachmentNotice(skipped.length ? t`Skipped ${skipped.join(", ")}` : null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [museMode, pendingAttachments, prepareAttachment, t],
  );
  const removeAttachment = useCallback(
    (attachment: PendingAttachment) => {
      abortAttachment(attachment.id);
      revokePendingAttachmentPreviews([attachment]);
      uploadedRef.current.delete(attachment.id);
      setPendingAttachments((current) => current.filter((item) => item.id !== attachment.id));
    },
    [abortAttachment],
  );
  /** Resolves `true` only when the message (or its routine/group action) really went out; every
   * other path resolves `false` so the composer gives the person's words back. */
  const sendMessage = useCallback(
    async (text: string, mentions: ComposerMention[] = []): Promise<boolean> => {
      const initialBotTarget = activeBotId.current;
      const initialGroupTarget = activeGroupId.current;
      if ((!initialBotTarget && !initialGroupTarget) || sending) return false;
      setFollowSignal((current) => current + 1);
      const originThreadKey = initialGroupTarget ?? initialBotTarget;
      const attachments = attachmentsForThread(pendingAttachments, originThreadKey);
      // A file still being read (or one that failed) holds the message back; Send is disabled.
      if (attachmentsBlockSend(attachments)) return false;
      const plan = resolveComposerSendPlan({
        text,
        mentions,
        hasAttachments: attachments.length > 0,
      });
      if (plan.isNoOp) return false;
      // The first real message closes the first-run welcome for good (muse/intro),
      // wherever it was sent from — the composer directly, or a welcome card's "Try it".
      if (museMode) markFirstRunSeen(userId, "welcome");
      const reroutedToGroup = Boolean(
        plan.rerouteGroupId && plan.rerouteGroupId !== initialGroupTarget,
      );
      const groupTarget = plan.rerouteGroupId ?? initialGroupTarget;
      const botTarget = reroutedToGroup ? undefined : initialBotTarget;
      if (
        plan.shouldSend &&
        (groupTarget || botsRef.current.find((bot) => bot.id === botTarget)?.notifyOnFinish)
      ) {
        const permissionRequest = requestBrowserNotificationPermission();
        if (permissionRequest) void permissionRequest.then(flushPendingBrowserNotifications);
      }
      const trimmed = plan.trimmed;
      setSending(true);
      setSendError(null);
      const dropDelayedSetup = () => {
        // Only after successful engagement so a failed upload/send keeps the setup card.
        if (initialBotTarget && focusPromptBotIdRef.current === initialBotTarget) {
          cancelFocusPrompt();
        }
      };
      try {
        if (plan.shouldRunRoutines) {
          const sendNonce = newClientId();
          await Promise.all(
            plan.routineIds.map((routineId) =>
              rpc.routines.testRun({
                routineId,
                clientNonce: `routine-mention:${sendNonce}:${routineId}`,
              }),
            ),
          );
        }
        if (!plan.shouldSend) {
          dropDelayedSetup();
          clearReply();
          revokePendingAttachmentPreviews(attachments);
          setPendingAttachments((current) =>
            current.filter((attachment) => attachment.threadKey !== originThreadKey),
          );
          setAttachmentNotice(null);
          if (reroutedToGroup && groupTarget) {
            navigate(`/app/g/${groupTarget}`);
            return true;
          }
          if (groupTarget && activeGroupId.current === groupTarget) {
            await refreshGroupThreadRef.current(groupTarget);
          } else if (botTarget && activeBotId.current === botTarget) {
            await refreshThreadRef.current(botTarget);
          }
          return true;
        }
        const artifactIds: string[] = [];
        const workspaceAttachments: WorkspaceAttachment[] = [];
        const toWorkspace = Boolean(museMode && botTarget && !groupTarget);
        let uploaded = 0;
        for (const pending of attachments) {
          const mimeType = inferAttachmentMimeType(pending.file.name, pending.file.type);
          if (!mimeType) {
            throw new Error(t`Unsupported file type: ${pending.file.name}`);
          }
          if (toWorkspace) {
            let stored = uploadedRef.current.get(pending.id);
            if (!stored) {
              setUploadStatus(t`Uploading ${uploaded + 1} of ${attachments.length}`);
              const contentBase64 = await readFileAsBase64(pending.file);
              const progress = t`Uploading ${uploaded + 1} of ${attachments.length}`;
              stored = await runWhenComputerReady(
                () =>
                  rpc.files.uploadAttachment({
                    botId: botTarget!,
                    name: pending.file.name,
                    mimeType,
                    contentBase64,
                  }),
                {
                  isStarting: isComputerStarting,
                  onStarting: () => setUploadStatus(t`Starting your Computer…`),
                  feed: computerFeed,
                  signal: sendAbort.current.signal,
                },
              );
              setUploadStatus(progress);
              uploadedRef.current.set(pending.id, stored);
            }
            uploaded += 1;
            workspaceAttachments.push(stored);
            continue;
          }
          const contentBase64 = await readFileAsBase64(pending.file);
          const artifact = await rpc.artifacts.create(
            groupTarget
              ? { groupId: groupTarget, name: pending.file.name, mimeType, contentBase64 }
              : { botId: botTarget!, name: pending.file.name, mimeType, contentBase64 },
          );
          artifactIds.push(artifact.id);
        }
        setUploadStatus(null);
        const clientNonce = newClientId();
        if (groupTarget) {
          await rpc.threads.send({
            groupId: groupTarget,
            clientNonce,
            text: trimmed || undefined,
            mentions: plan.mentionPayload.length ? plan.mentionPayload : undefined,
            artifactIds: artifactIds.length ? artifactIds : undefined,
            replyToMessageId: reroutedToGroup ? undefined : activeReplyTarget?.id,
            replyQuote: reroutedToGroup ? undefined : (activeReplyQuote ?? undefined),
          });
        } else if (botTarget) {
          // The Muse's messages are the engine's, with ids Nova has no row for: a quote travels
          // as text the engine records and the model reads, not as a reply link.
          const quoted = activeReplyQuote ? quotedMessageText(activeReplyQuote, trimmed) : trimmed;
          const sent = await rpc.threads.send({
            botId: botTarget,
            clientNonce,
            text: quoted || undefined,
            mentions: plan.mentionPayload.length ? plan.mentionPayload : undefined,
            artifactIds: artifactIds.length ? artifactIds : undefined,
            attachments: workspaceAttachments.length ? workspaceAttachments : undefined,
          });
          if (activeBotId.current === botTarget) {
            updateSnapshot((current) =>
              applyThreadSendReceipt(
                current,
                {
                  botId: botTarget,
                  runId: sent.runId,
                  taskId: sent.taskId,
                },
                terminalRunReceipts.current,
              ),
            );
          }
        }
        dropDelayedSetup();
        clearReply();
        revokePendingAttachmentPreviews(attachments);
        for (const sentAttachment of attachments) uploadedRef.current.delete(sentAttachment.id);
        setPendingAttachments((current) =>
          current.filter((attachment) => attachment.threadKey !== originThreadKey),
        );
        // Refresh sidebar status even when a bot→group reroute navigates away below.
        void refreshBots().catch(() => undefined);
        if (reroutedToGroup && groupTarget) {
          navigate(`/app/g/${groupTarget}`);
          return true;
        }
        if (groupTarget && activeGroupId.current === groupTarget) setAttachmentNotice(null);
        if (botTarget && activeBotId.current === botTarget) setAttachmentNotice(null);
        if (groupTarget) await refreshGroupThreadRef.current(groupTarget);
        else if (botTarget) await refreshThreadRef.current(botTarget);
        return true;
      } catch (error) {
        const failure = isComputerStarting(error)
          ? t`Your Computer is starting. Try again in a moment.`
          : userFacingError(error, t`Failed to send message`);
        if (reroutedToGroup && groupTarget) {
          setSendError(failure);
        } else if (groupTarget && activeGroupId.current === groupTarget) {
          setSendError(failure);
        } else if (botTarget && activeBotId.current === botTarget) {
          setSendError(failure);
        }
        // Nothing was sent: the composer puts the person's words back.
        return false;
      } finally {
        setUploadStatus(null);
        setSending(false);
      }
    },
    [
      activeReplyTarget?.id,
      activeReplyQuote,
      clearReply,
      flushPendingBrowserNotifications,
      museMode,
      navigate,
      pendingAttachments,
      sending,
      t,
      userId,
    ],
  );
  const sendCardReply = useCallback((text: string) => void sendMessage(text), [sendMessage]);
  const followUpMessage = useCallback(async (text: string) => {
    const id = activeBotId.current;
    if (!id) return;
    await rpc.threads.followUp({ botId: id, text });
    await refreshThreadRef.current(id);
  }, []);
  const stopRun = useCallback(async () => {
    if (sending) return;
    setSending(true);
    try {
      const botTarget = activeBotId.current;
      const groupTarget = activeGroupId.current;
      if (groupTarget) {
        setSendError(null);
        try {
          await rpc.threads.stop({ groupId: groupTarget });
        } catch (error) {
          if (activeGroupId.current === groupTarget) {
            setSendError(userFacingError(error, t`Failed to stop`));
          }
          return;
        }
        // Clear run UI ahead of the run.cancelled event so refresh races with in-flight gets.
        if (activeGroupId.current === groupTarget) {
          updateSnapshot((prev) =>
            prev && prev.groupId === groupTarget ? clearActiveThreadRuns(prev) : prev,
          );
        }
        await refreshGroupThreadRef.current(groupTarget).catch(() => undefined);
        return;
      }
      if (!botTarget) return;
      setSendError(null);
      try {
        await rpc.threads.stop({ botId: botTarget });
      } catch (error) {
        if (activeBotId.current === botTarget) {
          setSendError(userFacingError(error, t`Failed to stop`));
        }
        return;
      }
      // Clear local run/busy immediately rather than waiting for run.cancelled so a
      // superseded in-flight refresh (older cursor) cannot leave Stop enabled / Take control
      // blocked while the API is already idle.
      if (activeBotId.current === botTarget) {
        updateSnapshot((prev) =>
          !prev || (prev.botId !== botTarget && prev.botId) ? prev : clearActiveThreadRuns(prev),
        );
        const currentComputer = computerRef.current;
        if (currentComputer?.busyBotName) {
          commitComputer({ ...currentComputer, busyBotName: null });
        }
      }
      await refreshThreadRef.current(botTarget).catch(() => undefined);
    } finally {
      setSending(false);
    }
  }, [sending, t]);
  // F5/F6 (Feed, Ideas): tapping an Idea sends it in the Conversation, same
  // path as the composer, and switches the view there.

  function dismissComposerError() {
    // The strip shows one message at a time, so only dismiss the run failure when it is the
    // one on screen; otherwise a live run would be silenced before it has even failed.
    const failedRunId = displayedRunErrorId;
    setSendError(null);
    if (failedRunId) {
      rememberSeenRunErrorId(failedRunId);
      setDismissedRunErrorIds((current) => new Set(current).add(failedRunId));
    }
  }

  useEffect(() => {
    const threadKey = inGroup ? groupId : active?.id;
    // Leaving a chat drops its pending files; their reads stop with them.
    for (const attachment of pendingRef.current) {
      if (attachment.threadKey !== threadKey) abortAttachment(attachment.id);
    }
    setPendingAttachments((current) => {
      const stale = current.filter((attachment) => attachment.threadKey !== threadKey);
      revokePendingAttachmentPreviews(stale);
      return attachmentsForThread(current, threadKey);
    });
    clearReply();
    setAttachmentNotice(null);
    setSendError(null);
  }, [abortAttachment, active?.id, clearReply, groupId, inGroup]);
  return {
    pendingAttachments,
    activePendingAttachments,
    replyTarget,
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
    uploadStatus,
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
    retryAttachment,
    sendMessage,
    sendCardReply,
    followUpMessage,
    stopRun,
  };
}
