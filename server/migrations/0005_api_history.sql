CREATE TABLE api_history (
    id UUID PRIMARY KEY,
    item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    payload BYTEA NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running','completed','failed','cancelled','interrupted')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ
);
CREATE INDEX api_history_item_time ON api_history(item_id,created_at DESC);
