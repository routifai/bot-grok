-- The person's IANA zone name, so quiet hours (Muse proactivity) and the daily Followed-topic
-- digest (packages/adapters/src/muse/feed-jobs.ts) can be evaluated in their own time zone
-- instead of always UTC. Set by the web app once it knows the browser's zone
-- (apps/web/src/pages/muse/ProactivitySettings.tsx) via `preferences.update`; validated
-- server-side, invalid values fall back to "UTC".
ALTER TABLE "user" ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'UTC';
