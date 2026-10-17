// The activity capability's public entry point: the context panel's Activity panel, the live
// Activity feed behind it, and the Conversation's one work state (whether Superchat is working),
// which the shell, the transcript and the composer read.

export { ActivityPanel, GROUP_LABEL } from "./ActivityPanel";
export { ActivityRunById } from "./ActivityRunById";
export type { ActivityWire } from "./ActivityRunDialog";
export { AnsweredWhileWorking, useAnsweredWhileWorking } from "./AnsweredWhileWorking";
export { focusActivity, useActivityFocus } from "./activityFocus";
export { noteServerClock, serverNow, workingSince } from "./superchatWork";
export type { TurnStrip, TurnStrips } from "./turnStrips";
export { useTurnStrips } from "./turnStrips";
export type { ActivitiesState } from "./useActivities";
export { LIVE_ACTIVITY_WIRE, useActivities } from "./useActivities";
export { WorkingPill } from "./WorkingPill";
export { WorkStrip, WorkStripView } from "./WorkStrip";
export type { TranscriptWork } from "./workPlan";
export { drawnKey, drawnOnlyMessageIds, transcriptWork } from "./workPlan";
export type { TurnStatus, WorkPhase, WorkState } from "./workState";
export { deriveWorkState, IDLE_TURN, useWorkState } from "./workState";
export { formatClock } from "./workStripState";
