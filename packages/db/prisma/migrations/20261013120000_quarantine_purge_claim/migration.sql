-- A purge marks the organization while it works, so a restore and a purge cannot both win,
-- without clearing who the space belonged to (a retried discard must still find it).
ALTER TABLE "organization" ADD COLUMN "quarantinePurgeStartedAt" TIMESTAMP(3);
