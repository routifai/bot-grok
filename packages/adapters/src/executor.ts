// Thin public entry point for the run executor (ADR 0002 / R1 split). The engine used
// to live entirely in this ~5,700-line file; it is now organized by responsibility under
// ./executor/*, and this file re-exports exactly the public API it exported before the
// split so every existing import of "./executor.js" keeps working unchanged.

export {
  APPROVED_EFFECT_REPLAY_ORDER,
  approvalReplayEffectToolName,
  buildApprovalContinuation,
} from "./executor/approval-replay.js";
export type { UpdateBotPatch } from "./executor/bot-patch.js";
export { parseUpdateBotPatch } from "./executor/bot-patch.js";
export { isProtectedComputerLifecycleCommand } from "./executor/computer-safety.js";
export { persistLivePluginConnections, selectRunConnections } from "./executor/connections.js";
export { deferFutureRoutine } from "./executor/routine-scheduling.js";
export {
  completionMarksUnread,
  completionMessageSegments,
  completionNotificationBody,
  completionNotificationPreview,
  isExactNoResponse,
  LONG_WORK_PROGRESS_GUIDANCE,
  mayOpenModelStream,
  NO_RESPONSE,
  ROUTINE_SILENT_REPLY_GUIDANCE,
  runAllowsSilentEmpty,
  runPromotesMidTurnNarration,
  runReplyGuidance,
  runSendsFinishNotification,
  stripNoResponseReply,
  subagentMarksUnread,
} from "./executor/run-completion.js";
export { createRunExecutor } from "./executor/run-executor.js";
export { runNotificationsEnabled } from "./executor/run-notifications.js";
export {
  runIdentityInstruction,
  threadContextForRun,
  userTurnInstructions,
} from "./executor/run-prompt.js";
export {
  createRunWorkspaceCheckpoint,
  filterPageBrowserTools,
  PAGE_BROWSER_TOOL_NAMES,
  selectBuiltinToolsForRun,
} from "./executor/run-tools.js";
export {
  appendToolCompletionAudit,
  toolCompletionAuditPayload,
  toolCompletionFromResult,
} from "./executor/tool-completion.js";
export {
  loadCurrentTurnImages,
  missingTurnImagesInstruction,
  RECENT_TURN_IMAGE_BYTES,
  RECENT_TURN_IMAGE_TURNS,
  settleSteeringAttachmentLoads,
  withRecentTurnImages,
} from "./executor/turn-attachments.js";
export type { ExecutorDeps } from "./executor/types.js";
