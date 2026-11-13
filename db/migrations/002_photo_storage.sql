-- Photos move to object storage (S3 / R2 / MinIO, or a local folder in development).
-- Rows keep metadata + the object key; `data` stays only for photos not yet migrated
-- (`npm run photos:migrate` moves them out).

ALTER TABLE photos ALTER COLUMN data DROP NOT NULL;
ALTER TABLE photos ADD COLUMN storage_key text UNIQUE;
ALTER TABLE photos ADD COLUMN size int;
ALTER TABLE photos ADD CONSTRAINT photos_has_bytes CHECK (data IS NOT NULL OR storage_key IS NOT NULL);

-- Objects to delete from storage. Filled by a trigger, so every way a photo row disappears
-- (user delete, admin removal, account deletion cascade, replacing the main photo) is covered,
-- and the object is only deleted after the database change has committed.
CREATE TABLE storage_deletions (
  key        text PRIMARY KEY,
  queued_at  bigint NOT NULL,
  attempts   int NOT NULL DEFAULT 0,
  last_error text
);

CREATE FUNCTION queue_photo_object_delete() RETURNS trigger AS $$
BEGIN
  IF OLD.storage_key IS NOT NULL THEN
    INSERT INTO storage_deletions (key, queued_at)
    VALUES (OLD.storage_key, (extract(epoch FROM clock_timestamp()) * 1000)::bigint)
    ON CONFLICT (key) DO NOTHING;
  END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER photos_queue_object_delete AFTER DELETE ON photos
  FOR EACH ROW EXECUTE FUNCTION queue_photo_object_delete();
