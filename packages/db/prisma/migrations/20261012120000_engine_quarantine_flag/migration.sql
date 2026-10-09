-- Set when quarantine paused the person's engine account, so a later approval resets the engine
-- account (its memory, schedules and Computers) instead of resuming a squatter's context.
ALTER TABLE "user" ADD COLUMN "engineQuarantinePaused" BOOLEAN NOT NULL DEFAULT false;
