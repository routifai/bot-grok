-- One database, one schema per service: the API (Prisma) owns `app`, the Omnigent engine owns
-- `engine`. Idempotent: the db-init service runs it on every `up`, so an existing volume gets
-- the schemas too.
CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS engine;
