-- One database, one schema per service: the API (Prisma) owns `app`, the Omnigent engine owns
-- `engine`. Postgres runs it once, when it initializes an empty data volume.
CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS engine;
