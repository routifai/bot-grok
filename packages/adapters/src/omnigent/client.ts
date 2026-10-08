// Minimal typed client for the Omnigent REST API (engine/omnigent/omnigent/server/API.md,
// engine/omnigent/openapi.json), used by ./gateway.ts to run a Nova turn on Omnigent
// (docs/omnigent-spike.md). Every call carries the identity/proxy
// headers Omnigent's header auth mode expects — no SDK dependency, just fetch and a tiny
// SSE line parser mirroring apps/mobile/lib/api.ts's `subscribeThread`.
export * from "./client/activities.js";
export * from "./client/approvals.js";
export * from "./client/asks.js";
export * from "./client/computer.js";
export * from "./client/core.js";
export * from "./client/feed.js";
export * from "./client/memory.js";
export * from "./client/muse.js";
export * from "./client/objectives.js";
export * from "./client/scheduled.js";
export * from "./client/sessions.js";
export * from "./client/settings.js";
export * from "./client/side-chats.js";
export * from "./client/suggestions.js";
export * from "./client/taught-skills.js";
export * from "./client/transcript.js";
export * from "./client/vault.js";
