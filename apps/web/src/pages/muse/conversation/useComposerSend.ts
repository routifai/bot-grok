import { useLingui } from "@lingui/react/macro";
import type { Bot, ThreadMessage, ThreadSnapshot } from "@nova/contracts";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_COUNT, type MessageReaction } from "@nova/contracts";
import {
  attachmentsForThread,
  type ComposerMention,
  inferAttachmentMimeType,
  resolveComposerSendPlan,
} from "@nova/core";
import { type MutableRefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
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
import { notifyAsksChanged } from "../asks";
import type { useCreateBot } from "../chrome/useCreateBot";
import type { useComputerStore } from "../files/useComputerStore";
import { markFirstRunSeen } from "../intro";
import { quotedMessageText } from "./museTranscript";
import { type PendingAttachment, readFileAsBase64 } from "./shared";
import type { useThreadState } from "./useThreadState";
import type { useThreadSync } from "./useThreadSync";

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
  computerStore: Pick<ReturnType<typeof useComputerStore>, "computerRef" | "commitComputer">;
  focusPrompt: Pick<ReturnType<typeof useCreateBot>, "cancelFocusPrompt" | "focusPromptBotIdRef">;
}) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const { active, groupId, inGroup, activeBotId, activeGroupId } = target;
  const { terminalRunReceipts, refreshThreadRef, refreshGroupThreadRef, updateSnapshot } =
    threadOps;
  const { botsRef, refreshBots } = roster;
  const { computerRef, commitComputer } = computerStore;
  const { cancelFocusPrompt, focusPromptBotIdRef } = focusPrompt;
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [replyTarget, setReplyTarget] = useState<ThreadMessage | null>(null);
  const [replyQuote, setReplyQuote] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // First-run "Try it" chips (muse/intro/FirstRunWelcome.tsx) fill the composer with the
  // example rather than sending it, so the person sees it before it goes out.
  const [composerSeed, setComposerSeed] = useState<string | null>(null);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
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
  const displayedRunError = !sendError ? runError : null;
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
        setSendError(error instanceof Error ? error.message : t`Could not update reaction`);
      }
    },
    [t],
  );
  const onAttachmentPick = useCallback(
    async (files: FileList | null) => {
      const threadKey = activeGroupId.current ?? activeBotId.current;
      if (!threadKey || !files?.length) return;
      const existing = attachmentsForThread(pendingAttachments, threadKey);
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
          id: `${file.name}-${file.size}-${file.lastModified}-${next.length}`,
          threadKey,
          file,
          previewUrl: mimeType.startsWith("image/") ? URL.createObjectURL(file) : undefined,
        });
      }
      if (next.length) setPendingAttachments((current) => [...current, ...next]);
      setAttachmentNotice(skipped.length ? t`Skipped ${skipped.join(", ")}` : null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [pendingAttachments, t],
  );
  const removeAttachment = useCallback((attachment: PendingAttachment) => {
    revokePendingAttachmentPreviews([attachment]);
    setPendingAttachments((current) => current.filter((item) => item.id !== attachment.id));
  }, []);
  const sendMessage = useCallback(
    async (text: string, mentions: ComposerMention[] = []) => {
      const initialBotTarget = activeBotId.current;
      const initialGroupTarget = activeGroupId.current;
      if ((!initialBotTarget && !initialGroupTarget) || sending) return;
      setFollowSignal((current) => current + 1);
      const originThreadKey = initialGroupTarget ?? initialBotTarget;
      const attachments = attachmentsForThread(pendingAttachments, originThreadKey);
      const plan = resolveComposerSendPlan({
        text,
        mentions,
        hasAttachments: attachments.length > 0,
      });
      if (plan.isNoOp) return;
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
            return;
          }
          if (groupTarget && activeGroupId.current === groupTarget) {
            await refreshGroupThreadRef.current(groupTarget);
          } else if (botTarget && activeBotId.current === botTarget) {
            await refreshThreadRef.current(botTarget);
          }
          return;
        }
        const artifactIds: string[] = [];
        for (const pending of attachments) {
          const mimeType = inferAttachmentMimeType(pending.file.name, pending.file.type);
          if (!mimeType) {
            throw new Error(t`Unsupported file type: ${pending.file.name}`);
          }
          const contentBase64 = await readFileAsBase64(pending.file);
          const artifact = await rpc.artifacts.create(
            groupTarget
              ? { groupId: groupTarget, name: pending.file.name, mimeType, contentBase64 }
              : { botId: botTarget!, name: pending.file.name, mimeType, contentBase64 },
          );
          artifactIds.push(artifact.id);
        }
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
        setPendingAttachments((current) =>
          current.filter((attachment) => attachment.threadKey !== originThreadKey),
        );
        // Refresh sidebar status even when a bot→group reroute navigates away below.
        void refreshBots().catch(() => undefined);
        if (reroutedToGroup && groupTarget) {
          navigate(`/app/g/${groupTarget}`);
          return;
        }
        if (groupTarget && activeGroupId.current === groupTarget) setAttachmentNotice(null);
        if (botTarget && activeBotId.current === botTarget) setAttachmentNotice(null);
        if (groupTarget) await refreshGroupThreadRef.current(groupTarget);
        else if (botTarget) await refreshThreadRef.current(botTarget);
      } catch (error) {
        if (reroutedToGroup && groupTarget) {
          setSendError(error instanceof Error ? error.message : t`Failed to send message`);
        } else if (groupTarget && activeGroupId.current === groupTarget) {
          setSendError(error instanceof Error ? error.message : t`Failed to send message`);
        } else if (botTarget && activeBotId.current === botTarget) {
          setSendError(error instanceof Error ? error.message : t`Failed to send message`);
        }
      } finally {
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
            setSendError(error instanceof Error ? error.message : t`Failed to stop`);
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
          setSendError(error instanceof Error ? error.message : t`Failed to stop`);
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
    setPendingAttachments((current) => {
      const stale = current.filter((attachment) => attachment.threadKey !== threadKey);
      revokePendingAttachmentPreviews(stale);
      return attachmentsForThread(current, threadKey);
    });
    clearReply();
    setAttachmentNotice(null);
    setSendError(null);
  }, [active?.id, clearReply, groupId, inGroup]);
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
  };
}
