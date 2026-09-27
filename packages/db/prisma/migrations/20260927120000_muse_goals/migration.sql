-- Muse edition (B3): Goal / GoalTask / GoalProposal, and the Goal log Thread link.
-- See CONTEXT.md and docs/muse/PLAN.md B3.

CREATE TABLE "goals" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL DEFAULT 'active',
  "due" TIMESTAMP(3),
  "checkInCrons" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "timezone" TEXT NOT NULL DEFAULT 'UTC',
  "lastWorkedAt" TIMESTAMP(3),
  "nextWorkAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "goals_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "goals_spaceId_botId_status_idx" ON "goals"("spaceId", "botId", "status");
CREATE INDEX "goals_nextWorkAt_idx" ON "goals"("nextWorkAt");

ALTER TABLE "goals" ADD CONSTRAINT "goals_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "goals" ADD CONSTRAINT "goals_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "goal_tasks" (
  "id" TEXT NOT NULL,
  "goalId" TEXT NOT NULL,
  "idx" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "note" TEXT NOT NULL DEFAULT '',
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "goal_tasks_pkey" PRIMARY KEY ("id")
);

-- No unique constraint on (goalId, idx): accepting a Proposal replaces/reorders the
-- whole plan, so idx values are briefly non-unique mid-transaction.
CREATE INDEX "goal_tasks_goalId_idx_idx" ON "goal_tasks"("goalId", "idx");

ALTER TABLE "goal_tasks" ADD CONSTRAINT "goal_tasks_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "goals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "goal_proposals" (
  "id" TEXT NOT NULL,
  "goalId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "tasks" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "askMessageId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedAt" TIMESTAMP(3),

  CONSTRAINT "goal_proposals_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "goal_proposals_goalId_status_idx" ON "goal_proposals"("goalId", "status");

ALTER TABLE "goal_proposals" ADD CONSTRAINT "goal_proposals_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "goals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One open proposal per goal (decision 4 / CONTEXT.md relationships).
CREATE UNIQUE INDEX "goal_proposals_goalId_open_key" ON "goal_proposals"("goalId") WHERE "status" = 'open';

-- A Goal log: a Thread with goalId set and botId null (bot threads keep botId unique
-- as today). Goal-log behaviour itself is not implemented yet (B3 is schema-only).
ALTER TABLE "threads" ADD COLUMN "goalId" TEXT;
CREATE UNIQUE INDEX "threads_goalId_key" ON "threads"("goalId");
ALTER TABLE "threads" ADD CONSTRAINT "threads_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "goals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
