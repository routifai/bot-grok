-- Per-Muse Omnigent harness choice (docs/omnigent-spike.md, packages/contracts/src/engine.ts):
-- a person can pick which harness their Muse's Conversation turns run on, and switch mid-
-- Conversation. NULL museHarness means the deployment default (OMNIGENT_AGENT_NAME's harness).
--
-- omnigent_sessions.agentName records which built-in agent bundle a session currently runs on,
-- so the gateway only calls switch-agent when the resolved harness actually differs.

ALTER TABLE "bots" ADD COLUMN "museHarness" TEXT;
ALTER TABLE "omnigent_sessions" ADD COLUMN "agentName" TEXT NOT NULL DEFAULT 'nova-pi';
