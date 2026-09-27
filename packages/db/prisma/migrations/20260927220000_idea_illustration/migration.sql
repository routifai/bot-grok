-- Muse edition: Idea gains an optional `detail` (1-3 sentence explanation) and an
-- optional `illustration` key (bundled 3D illustration, see @aiden/contracts
-- IllustrationKeySchema). Both nullable so existing rows keep parsing unchanged.
-- See CONTEXT.md "Idea" and docs/muse/PLAN.md B11.

ALTER TABLE "ideas" ADD COLUMN "detail" TEXT;
ALTER TABLE "ideas" ADD COLUMN "illustration" TEXT;
