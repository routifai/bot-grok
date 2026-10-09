-- Per-address send/verify caps live in their own table. Better Auth's rate limiter deletes rows
-- from "rate_limit" once they are older than its longest window (about a minute), which would
-- reset hourly and daily caps; this table is only ever written by the caps themselves.
CREATE TABLE "email_quota" (
  "key" TEXT NOT NULL,
  "count" INTEGER NOT NULL,
  "windowStart" BIGINT NOT NULL,
  CONSTRAINT "email_quota_pkey" PRIMARY KEY ("key")
);
-- Stale windows can be purged by age; index the column that purge filters on.
CREATE INDEX "email_quota_windowStart_idx" ON "email_quota"("windowStart");
