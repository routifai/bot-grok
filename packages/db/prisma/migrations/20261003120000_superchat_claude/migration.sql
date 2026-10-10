-- Super Chat slice A1 (docs/super-chat/WIRING.md): Superchat's Omnigent agent bundle is now
-- `superchat-claude` only (superchat-pi/superchat-openai/superchat-codex retired, see
-- packages/adapters/src/omnigent/harnesses.ts). New sessions default to it.
--
-- lastMirroredItemId: the mirror job (packages/adapters/src/omnigent/mirror.ts) copies
-- assistant messages the Super Chat produces on its own (a Helper's Result waking it, "the
-- Muse speaks first") into the Superchat thread. The gateway stamps this to the turn's last item id
-- right after every normal turn, so the mirror job only ever looks at items after it and never
-- re-delivers a reply the run path already posted.

ALTER TABLE "omnigent_sessions" ALTER COLUMN "agentName" SET DEFAULT 'superchat-claude';
ALTER TABLE "omnigent_sessions" ADD COLUMN "lastMirroredItemId" TEXT;
