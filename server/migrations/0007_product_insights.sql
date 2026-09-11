CREATE TABLE workbench_preferences (
    id INTEGER PRIMARY KEY CHECK(id=1),
    usage_enabled BOOLEAN NOT NULL DEFAULT true,
    usage_since TIMESTAMPTZ NOT NULL DEFAULT now(),
    onboarding_hidden BOOLEAN NOT NULL DEFAULT false
);
INSERT INTO workbench_preferences(id) VALUES(1);
CREATE TABLE usage_events (
    id UUID PRIMARY KEY,
    event TEXT NOT NULL CHECK(event IN ('session_started','item_created','item_opened','search','request_sent','ingest_queued','ingest_completed')),
    item_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX usage_events_date ON usage_events(created_at);
CREATE TABLE feedback (
    id UUID PRIMARY KEY,
    payload BYTEA NOT NULL,
    resolved BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
