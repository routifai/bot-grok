-- ADR 0009: the engine owns each person's Muse (`/v1/me/muse`). A Conversation started before
-- that is claimed once with `POST /v1/me/muse/adopt`; this records that it was, so it is not
-- repeated.
ALTER TABLE "omnigent_sessions" ADD COLUMN "engineAdoptedAt" TIMESTAMP(3);
