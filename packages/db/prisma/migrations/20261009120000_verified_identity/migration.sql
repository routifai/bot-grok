-- Verified identity: one signup mode replaces signupsEnabled, and users gain an approval status.
CREATE TYPE "SignupMode" AS ENUM ('closed', 'invite', 'domain', 'approval', 'open');
CREATE TYPE "UserStatus" AS ENUM ('pending', 'active', 'suspended');

ALTER TABLE "deployment_settings"
  ADD COLUMN "signupMode" "SignupMode" NOT NULL DEFAULT 'open',
  ADD COLUMN "signupDomains" TEXT NOT NULL DEFAULT '';

-- Preserve effective behavior: disabled signups close, an allow-list becomes the invite list.
-- Rows the API has not initialized yet keep the default; the API seeds them from the environment.
-- "signupsEnabled" is deprecated but kept for one release so an old replica running beside a new
-- one during a rolling deploy still finds it; new code keeps it in step with the mode.
UPDATE "deployment_settings"
SET "signupMode" = CASE
  WHEN NOT "signupsEnabled" THEN 'closed'::"SignupMode"
  WHEN "signupAllowlist" <> '' THEN 'invite'::"SignupMode"
  ELSE 'open'::"SignupMode"
END
WHERE "signupPolicyInitialized";

-- Every existing user keeps access.
ALTER TABLE "user" ADD COLUMN "status" "UserStatus" NOT NULL DEFAULT 'active';

-- Email proof is now required to hold a session. People who already got a space were usable
-- before without it; mark them verified so the upgrade does not lock them out. Accounts that
-- never got a space stay unverified and must prove their mailbox.
UPDATE "user"
SET "emailVerified" = true
WHERE NOT "emailVerified"
  AND EXISTS (SELECT 1 FROM "space_members" WHERE "space_members"."userId" = "user"."id");

-- Shared counters for the auth rate limiter and per-address send/verify caps.
CREATE TABLE "rate_limit" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "count" INTEGER NOT NULL,
  "lastRequest" BIGINT NOT NULL,
  CONSTRAINT "rate_limit_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "rate_limit_key_key" ON "rate_limit"("key");
