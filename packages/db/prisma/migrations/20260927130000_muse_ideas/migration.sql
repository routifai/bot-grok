-- Muse edition (B11): Idea, replaced wholesale on refresh.
-- See CONTEXT.md "Idea" and docs/muse/PLAN.md B11.

CREATE TABLE "ideas" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "area" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ideas_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ideas_botId_createdAt_idx" ON "ideas"("botId", "createdAt");

ALTER TABLE "ideas" ADD CONSTRAINT "ideas_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
