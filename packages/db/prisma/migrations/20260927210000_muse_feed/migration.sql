-- Muse edition (B10): Post / FollowedTopic, and the Feed log Thread link.
-- See CONTEXT.md ("Feed", "Post", "Followed topic") and docs/muse/PLAN.md B10.

CREATE TABLE "posts" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "goalId" TEXT,
  "sourceUrl" TEXT,
  "artifactId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "posts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "posts_botId_createdAt_idx" ON "posts"("botId", "createdAt");

ALTER TABLE "posts" ADD CONSTRAINT "posts_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "posts" ADD CONSTRAINT "posts_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "posts" ADD CONSTRAINT "posts_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "goals"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "posts" ADD CONSTRAINT "posts_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "artifacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "followed_topics" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "topic" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "followed_topics_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "followed_topics_botId_topic_key" ON "followed_topics"("botId", "topic");
CREATE INDEX "followed_topics_botId_createdAt_idx" ON "followed_topics"("botId", "createdAt");

ALTER TABLE "followed_topics" ADD CONSTRAINT "followed_topics_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "followed_topics" ADD CONSTRAINT "followed_topics_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The Feed log: one Muse's own Thread for feed.topics research turns, reused across
-- every run the same way a Goal log Thread is (see 20260927120000_muse_goals).
ALTER TABLE "threads" ADD COLUMN "feedLogBotId" TEXT;
CREATE UNIQUE INDEX "threads_feedLogBotId_key" ON "threads"("feedLogBotId");
ALTER TABLE "threads" ADD CONSTRAINT "threads_feedLogBotId_fkey" FOREIGN KEY ("feedLogBotId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
