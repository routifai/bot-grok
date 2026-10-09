// The activity capability's public entry point: the context panel's Activity panel and the live
// Activity feed behind it (also the source of Nova's "working" state for the shell and sidebar).

export { ActivityPanel, GROUP_LABEL } from "./ActivityPanel";
export type { ActivityWire } from "./ActivityRunDialog";
export { type ActivitiesState, LIVE_ACTIVITY_WIRE, useActivities } from "./useActivities";
export { useNovaWork } from "./useNovaWork";
