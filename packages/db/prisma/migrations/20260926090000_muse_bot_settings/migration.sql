-- Muse edition (packages/contracts/src/muse.ts, MuseSettings): per-bot Proactivity level
-- and quiet-hours window. NULL means "use DEFAULT_MUSE_SETTINGS"; museQuietHours stores ""
-- for "quiet hours explicitly turned off" (distinct from NULL, "not set yet").
ALTER TABLE "bots" ADD COLUMN "museProactivity" TEXT;
ALTER TABLE "bots" ADD COLUMN "museQuietHours" TEXT;
