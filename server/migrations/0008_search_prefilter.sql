-- Search prefilter. item_search keeps one lowercase text per item, maintained
-- by a trigger, so PostgreSQL can discard non-matching rows before the
-- application scores them. It is derived data: not part of backups, rebuilt
-- automatically when items are inserted (including restores).
CREATE OR REPLACE FUNCTION infohub_search_text(
    title TEXT, project TEXT, summary TEXT, url TEXT, category TEXT, tags TEXT[], data JSONB
) RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT lower(concat_ws(' ', title, project, summary, url, category,
                           array_to_string(tags, ' '), data::text))
$$;

CREATE TABLE item_search (
    item_id UUID PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    text TEXT NOT NULL
);

CREATE OR REPLACE FUNCTION infohub_item_search_sync() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO item_search(item_id, text)
    VALUES (NEW.id, infohub_search_text(NEW.title, NEW.project, NEW.summary, NEW.url,
                                        NEW.category, NEW.tags, NEW.data))
    ON CONFLICT (item_id) DO UPDATE SET text = EXCLUDED.text;
    RETURN NULL;
END $$;

CREATE TRIGGER items_search_sync
AFTER INSERT OR UPDATE OF title, project, summary, url, category, tags, data ON items
FOR EACH ROW EXECUTE FUNCTION infohub_item_search_sync();

INSERT INTO item_search(item_id, text)
SELECT id, infohub_search_text(title, project, summary, url, category, tags, data) FROM items;

-- pg_trgm makes '%term%' lookups indexable (terms of 3+ characters). It is a
-- trusted extension on PostgreSQL 13+, but some managed databases forbid it;
-- search still works without the index.
DO $$
BEGIN
    BEGIN
        CREATE EXTENSION IF NOT EXISTS pg_trgm;
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'pg_trgm unavailable (%); search runs without trigram index', SQLERRM;
    END;
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
        EXECUTE 'CREATE INDEX item_search_trgm ON item_search USING GIN (text gin_trgm_ops)';
    END IF;
END $$;
