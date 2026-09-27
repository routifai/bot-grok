-- `threads_owner_chk` (20260906120000_messaging_team_chat) still only counts
-- botId/groupId/externalConversationId, so it rejects every Goal log and Feed log
-- Thread outright: both are owned by goalId / feedLogBotId instead
-- (20260927120000_muse_goals, 20260927210000_muse_feed added those columns but never
-- widened this constraint). Every `goals` tool `create` call and every Muse's first
-- Followed topic have been failing the insert ever since. Widen the constraint to the
-- five owner columns that now exist.
ALTER TABLE "threads" DROP CONSTRAINT "threads_owner_chk";
ALTER TABLE "threads" ADD CONSTRAINT "threads_owner_chk" CHECK (
  num_nonnulls("botId", "groupId", "externalConversationId", "goalId", "feedLogBotId") = 1
);
