-- Verified identity: one signup mode replaces signupsEnabled, and users gain an approval status.
CREATE TYPE "SignupMode" AS ENUM ('closed', 'invite', 'domain', 'approval', 'open');
CREATE TYPE "UserStatus" AS ENUM ('pending', 'active', 'suspended');

ALTER TABLE "deployment_settings"
  ADD COLUMN "signupMode" "SignupMode" NOT NULL DEFAULT 'open',
  ADD COLUMN "signupDomains" TEXT NOT NULL DEFAULT '';

-- Preserve effective behavior: disabled signups close, an allow-list becomes the invite list.
-- Rows the API has not initialized yet keep the default; the API seeds them from the environment.
UPDATE "deployment_settings"
SET "signupMode" = CASE
  WHEN NOT "signupsEnabled" THEN 'closed'::"SignupMode"
  WHEN "signupAllowlist" <> '' THEN 'invite'::"SignupMode"
  ELSE 'open'::"SignupMode"
END
WHERE "signupPolicyInitialized";

ALTER TABLE "deployment_settings" DROP COLUMN "signupsEnabled";

-- Every existing user keeps access.
ALTER TABLE "user" ADD COLUMN "status" "UserStatus" NOT NULL DEFAULT 'active';
