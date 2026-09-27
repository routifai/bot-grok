-- Every run reconnects a running computer (running -> booting -> running) without
-- replacing it. Keep screens open across that hop; a changed providerRef still revokes.
CREATE OR REPLACE FUNCTION revoke_computer_screens() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.state IS DISTINCT FROM OLD.state
      AND NOT (OLD.state = 'booting' AND NEW.state = 'running')
      AND NOT (OLD.state = 'running' AND NEW.state = 'booting'))
    OR NEW."providerRef" IS DISTINCT FROM OLD."providerRef" THEN
    NEW."screenGeneration" := OLD."screenGeneration" + 1;
  END IF;
  RETURN NEW;
END;
$$;
