-- A space used by an unverified account is quarantined, not deleted, when its mailbox is proved.
ALTER TABLE "organization"
  ADD COLUMN "quarantinedFromUserId" TEXT,
  ADD COLUMN "quarantinedAt" TIMESTAMP(3);
CREATE INDEX "organization_quarantinedAt_idx" ON "organization"("quarantinedAt");

-- The API records whether it can send mail so every process applies the same rule.
ALTER TABLE "deployment_settings" ADD COLUMN "emailDelivery" BOOLEAN NOT NULL DEFAULT false;
