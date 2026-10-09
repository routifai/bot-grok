// Minimal typed client for the Omnigent REST API (engine/omnigent/omnigent/server/API.md,
// engine/omnigent/openapi.json), used by ./gateway.ts to run a Nova turn on Omnigent
// (docs/omnigent-spike.md). Every call carries the identity/proxy
// headers Omnigent's header auth mode expects — no SDK dependency, just fetch and a tiny
// SSE line parser mirroring apps/mobile/lib/api.ts's `subscribeThread`.
export * from "./activity.js";
export * from "./approvals.js";
export * from "./client/core.js";
export * from "./client/muse.js";
export * from "./client/scheduled.js";
export * from "./client/sessions.js";
export * from "./client/settings.js";
export * from "./client/transcript.js";
export * from "./computer.js";
export * from "./daily-notes.js";
export * from "./feed.js";
export * from "./goals.js";
export * from "./ideas.js";
export * from "./memory.js";
export * from "./models.js";
export * from "./side-chats.js";
export * from "./skills.js";
export * from "./vault.js";
