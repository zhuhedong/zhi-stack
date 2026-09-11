ALTER TABLE items ADD COLUMN deleted_at TIMESTAMPTZ;
CREATE INDEX items_live ON items(kind, updated_at DESC) WHERE deleted_at IS NULL;
DROP INDEX items_source_unique;
CREATE UNIQUE INDEX items_source_unique ON items(kind, url)
    WHERE url <> '' AND kind <> 'credential' AND deleted_at IS NULL;

-- Snapshots are taken in the same transaction as the change. Credential JSON
-- stays empty; the separately stored ciphertext keeps the original item AAD.
CREATE TABLE item_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    revision BIGINT NOT NULL,
    snapshot JSONB NOT NULL,
    secret BYTEA,
    reason TEXT NOT NULL DEFAULT 'edit',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(item_id, revision)
);
CREATE TABLE version_media (
    version_id UUID NOT NULL REFERENCES item_versions(id) ON DELETE CASCADE,
    media_id UUID NOT NULL,
    source_url TEXT NOT NULL,
    mime TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    storage_key TEXT NOT NULL REFERENCES file_objects(key),
    PRIMARY KEY(version_id, media_id)
);
CREATE INDEX version_media_storage ON version_media(storage_key);
CREATE INDEX version_media_id ON version_media(media_id);
CREATE OR REPLACE FUNCTION track_file_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP IN ('DELETE', 'UPDATE') THEN
        UPDATE file_objects f SET delete_after = CASE WHEN
          EXISTS(SELECT 1 FROM attachments a WHERE a.storage_key=f.key) OR
          EXISTS(SELECT 1 FROM media m WHERE m.storage_key=f.key) OR
          EXISTS(SELECT 1 FROM version_media v WHERE v.storage_key=f.key)
          THEN NULL ELSE now() END WHERE key=OLD.storage_key;
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
        UPDATE file_objects SET delete_after=NULL WHERE key=NEW.storage_key;
    END IF;
    RETURN NULL;
END;
$$;
CREATE TRIGGER version_media_file_reference
    AFTER INSERT OR DELETE OR UPDATE OF storage_key ON version_media
    FOR EACH ROW EXECUTE FUNCTION track_file_reference();

CREATE FUNCTION snapshot_item() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE version_uuid UUID;
BEGIN
    IF current_setting('infohub.skip_snapshot', true) = 'on' THEN RETURN NEW; END IF;
    IF (to_jsonb(OLD) - 'revision' - 'updated_at') IS NOT DISTINCT FROM
       (to_jsonb(NEW) - 'revision' - 'updated_at') THEN RETURN NEW; END IF;
    INSERT INTO item_versions(item_id, revision, snapshot, secret, reason)
    VALUES(OLD.id, OLD.revision, to_jsonb(OLD) - 'secret', OLD.secret,
           COALESCE(NULLIF(current_setting('infohub.change_reason', true), ''), 'edit'))
    ON CONFLICT(item_id, revision) DO NOTHING RETURNING id INTO version_uuid;
    IF version_uuid IS NOT NULL THEN
        INSERT INTO version_media(version_id, media_id, source_url, mime, sha256, storage_key)
        SELECT version_uuid, id, source_url, mime, sha256, storage_key FROM media WHERE item_id=OLD.id;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER items_snapshot BEFORE UPDATE ON items FOR EACH ROW EXECUTE FUNCTION snapshot_item();

CREATE TABLE drafts (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 200),
    kind TEXT NOT NULL CHECK(kind IN ('knowledge','repo','credential')),
    item_id UUID REFERENCES items(id) ON DELETE CASCADE,
    base_revision BIGINT,
    payload BYTEA NOT NULL,
    encrypted BOOLEAN NOT NULL,
    generation BIGINT NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK(encrypted = (kind='credential'))
);
CREATE TABLE backup_runs (
    id UUID PRIMARY KEY,
    operation TEXT NOT NULL CHECK(operation IN ('backup','restore')),
    status TEXT NOT NULL CHECK(status IN ('running','success','failed','interrupted')),
    size BIGINT,
    message TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ
);
