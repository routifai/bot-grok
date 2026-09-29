-- NOVA_ENGINE=omnigent spike (docs/omnigent-spike.md): one Omnigent session id per Muse
-- (bot), so every turn continues the same Omnigent conversation instead of creating a
-- new one each time.

CREATE TABLE "omnigent_sessions" (
  "id" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "omnigentSessionId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "omnigent_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "omnigent_sessions_botId_key" ON "omnigent_sessions"("botId");

ALTER TABLE "omnigent_sessions" ADD CONSTRAINT "omnigent_sessions_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
