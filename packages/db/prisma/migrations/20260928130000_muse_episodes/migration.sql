-- Episodic memory: one short, dated record per finished task (see CONTEXT.md and
-- packages/adapters/src/muse/episodes.ts / packages/core/src/muse/episodes.ts).

CREATE TABLE "episodes" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "threadId" TEXT NOT NULL,
  "goalId" TEXT,
  "trigger" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "tools" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "links" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "episodes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "episodes_runId_key" ON "episodes"("runId");
CREATE INDEX "episodes_botId_createdAt_idx" ON "episodes"("botId", "createdAt");

ALTER TABLE "episodes" ADD CONSTRAINT "episodes_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
