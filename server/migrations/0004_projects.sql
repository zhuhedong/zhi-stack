CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT UNIQUE NOT NULL CHECK(octet_length(name) BETWEEN 1 AND 500),
    description TEXT NOT NULL DEFAULT '',
    archived BOOLEAN NOT NULL DEFAULT false,
    revision BIGINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO projects(name) SELECT DISTINCT project FROM items WHERE project<>'';
CREATE FUNCTION ensure_item_project() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.project<>'' THEN INSERT INTO projects(name) VALUES(NEW.project) ON CONFLICT(name) DO NOTHING; END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER item_project BEFORE INSERT OR UPDATE OF project ON items FOR EACH ROW EXECUTE FUNCTION ensure_item_project();

CREATE TABLE item_relations (
    source_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    target_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    label TEXT NOT NULL DEFAULT '相关资料' CHECK(length(label) BETWEEN 1 AND 100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(source_id,target_id),
    CHECK(source_id<>target_id)
);
CREATE INDEX item_relations_target ON item_relations(target_id);
CREATE TABLE item_state (
    item_id UUID PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    archived BOOLEAN NOT NULL DEFAULT false,
    later BOOLEAN NOT NULL DEFAULT false,
    progress INTEGER NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
    annotation TEXT NOT NULL DEFAULT '',
    last_opened_at TIMESTAMPTZ,
    visit_count BIGINT NOT NULL DEFAULT 0,
    revision BIGINT NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX item_recent ON item_state(last_opened_at DESC);
CREATE TABLE saved_views (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
    filters BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
