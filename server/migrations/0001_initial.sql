CREATE TABLE vault_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    salt BYTEA NOT NULL,
    verifier BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE items (
    id UUID PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('knowledge', 'repo', 'credential')),
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
    category TEXT NOT NULL DEFAULT '',
    project TEXT NOT NULL DEFAULT '',
    tags TEXT[] NOT NULL DEFAULT '{}',
    summary TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    data JSONB NOT NULL DEFAULT '{}',
    secret BYTEA,
    favorite BOOLEAN NOT NULL DEFAULT false,
    revision BIGINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((kind = 'credential' AND secret IS NOT NULL AND data = '{}'::jsonb)
        OR (kind <> 'credential' AND secret IS NULL))
);
CREATE INDEX items_kind_updated ON items(kind, updated_at DESC);
CREATE INDEX items_category ON items(kind, category);
CREATE INDEX items_project ON items(project);
CREATE INDEX items_tags ON items USING GIN(tags);
CREATE UNIQUE INDEX items_source_unique ON items(kind, url) WHERE url <> '' AND kind <> 'credential';

CREATE TABLE attachments (
    id UUID PRIMARY KEY,
    item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size BIGINT NOT NULL,
    content BYTEA NOT NULL,
    encrypted BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX attachments_item ON attachments(item_id);

CREATE TABLE media (
    id UUID PRIMARY KEY,
    item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    source_url TEXT NOT NULL,
    mime TEXT NOT NULL,
    content BYTEA NOT NULL,
    sha256 TEXT NOT NULL,
    UNIQUE(item_id, source_url)
);

