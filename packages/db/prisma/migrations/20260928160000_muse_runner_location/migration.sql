-- Per-Muse Omnigent runner location (docs/omnigent-spike.md "Nova computer" runner launcher,
-- packages/contracts/src/engine.ts NovaRunnerLocationId): a person can pick whether their
-- Muse's Omnigent runner executes inside its own sandbox computer or on their connected
-- `omnigent host`. NULL museRunnerLocation means the deployment default ("computer").
--
-- omnigent_sessions.runnerLocation records which location a session was bound on, so the
-- gateway can tell when Bot.museRunnerLocation has since changed and the session needs
-- recreating (there is no switch-location RPC, unlike switch-agent).

ALTER TABLE "bots" ADD COLUMN "museRunnerLocation" TEXT;
ALTER TABLE "omnigent_sessions" ADD COLUMN "runnerLocation" TEXT NOT NULL DEFAULT 'computer';
