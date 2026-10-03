-- Super Chat slice A1 (docs/super-chat/WIRING.md): Nova's Omnigent agent bundle is now
-- `nova-claude` only (nova-pi/nova-openai/nova-codex retired, see
-- packages/adapters/src/omnigent/harnesses.ts). New sessions default to it.
--
-- lastMirroredItemId: the mirror job (packages/adapters/src/omnigent/mirror.ts) copies
-- assistant messages the Super Chat produces on its own (a Helper's Result waking it, "the
-- Muse speaks first") into the Nova thread. The gateway stamps this to the turn's last item id
-- right after every normal turn, so the mirror job only ever looks at items after it and never
-- re-delivers a reply the run path already posted.

ALTER TABLE "omnigent_sessions" ALTER COLUMN "agentName" SET DEFAULT 'nova-claude';
ALTER TABLE "omnigent_sessions" ADD COLUMN "lastMirroredItemId" TEXT;
