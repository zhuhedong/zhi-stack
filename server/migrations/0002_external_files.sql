-- File bytes are exported by the server before it accepts requests. Keeping the
-- legacy columns temporarily makes that export resumable after a failed write.
CREATE TABLE file_objects (
    key TEXT PRIMARY KEY,
    storage_id TEXT NOT NULL,
    size BIGINT NOT NULL CHECK (size >= 0),
    sha256 TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    delete_after TIMESTAMPTZ DEFAULT now() + INTERVAL '1 hour',
    cleanup_attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX file_objects_cleanup ON file_objects(delete_after) WHERE delete_after IS NOT NULL;

ALTER TABLE attachments RENAME COLUMN content TO legacy_content;
ALTER TABLE attachments ALTER COLUMN legacy_content DROP NOT NULL;
ALTER TABLE attachments ADD COLUMN storage_key TEXT UNIQUE REFERENCES file_objects(key);
ALTER TABLE media RENAME COLUMN content TO legacy_content;
ALTER TABLE media ALTER COLUMN legacy_content DROP NOT NULL;
ALTER TABLE media ADD COLUMN storage_key TEXT UNIQUE REFERENCES file_objects(key);

-- The queue is committed in the same transaction as the metadata, including
-- cascades from items and image replacements. Rollbacks cannot delete live files.
CREATE FUNCTION track_file_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP IN ('DELETE', 'UPDATE') THEN
        UPDATE file_objects SET delete_after = now() WHERE key = OLD.storage_key;
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
        UPDATE file_objects SET delete_after = NULL WHERE key = NEW.storage_key;
    END IF;
    RETURN NULL;
END;
$$;
CREATE TRIGGER attachments_file_reference
    AFTER INSERT OR DELETE OR UPDATE OF storage_key ON attachments
    FOR EACH ROW EXECUTE FUNCTION track_file_reference();
CREATE TRIGGER media_file_reference
    AFTER INSERT OR DELETE OR UPDATE OF storage_key ON media
    FOR EACH ROW EXECUTE FUNCTION track_file_reference();
