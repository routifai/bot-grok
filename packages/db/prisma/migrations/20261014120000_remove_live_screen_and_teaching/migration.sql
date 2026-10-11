-- The live Computer screen and "teach a task" are gone. Runs that were waiting for the person to
-- take over can no longer resume, so they end as cancelled.
UPDATE "runs" SET "status" = 'cancelled' WHERE "status" = 'waiting_takeover';
UPDATE "attempts" SET "status" = 'cancelled' WHERE "status" = 'waiting_takeover';
-- The "skill" run trigger belonged to testing a taught skill; an ordinary typed turn replaces it.
UPDATE "runs" SET "trigger" = 'user' WHERE "trigger" = 'skill';

-- Their events and the skill-draft cards no longer exist in the product.
DELETE FROM "events"
WHERE "type" IN (
  'computer.takeover.requested',
  'computer.takeover.granted',
  'computer.takeover.released',
  'skill.teaching.started',
  'skill.teaching.stopped',
  'skill.draft.created',
  'skill.saved'
);
UPDATE "messages"
SET "blocks" = (
  SELECT COALESCE(jsonb_agg(block), '[]'::jsonb)
  FROM jsonb_array_elements("blocks"::jsonb) AS block
  WHERE block ->> 'kind' <> 'skill_draft'
)
WHERE "blocks"::text LIKE '%"skill_draft"%';

-- Taught skills.
DROP TABLE "taught_skills";

-- Screen links and control leases.
DROP INDEX IF EXISTS "computers_controlLeaseExpiresAt_id_idx";
ALTER TABLE "computers"
  DROP COLUMN "screenGeneration",
  DROP COLUMN "controlHolder",
  DROP COLUMN "controlLeaseId",
  DROP COLUMN "controlLeaseExpiresAt",
  DROP COLUMN "controlBotId",
  DROP COLUMN "controlRunId",
  DROP COLUMN "controlFence",
  DROP COLUMN "screenUrl";
ALTER TABLE "bots" DROP COLUMN "screenGeneration";

-- The "take over" notification preference.
ALTER TABLE "notification_preferences" DROP COLUMN "takeover";
