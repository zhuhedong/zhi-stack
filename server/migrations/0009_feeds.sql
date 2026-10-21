CREATE TABLE feeds (
    id UUID PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL DEFAULT '',
    site_url TEXT NOT NULL DEFAULT '',
    project TEXT NOT NULL DEFAULT '',
    tags JSONB NOT NULL DEFAULT '[]',
    enabled BOOLEAN NOT NULL DEFAULT true,
    interval_minutes INTEGER NOT NULL DEFAULT 60 CHECK(interval_minutes BETWEEN 15 AND 10080),
    next_check_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_checked_at TIMESTAMPTZ,
    checking BOOLEAN NOT NULL DEFAULT false,
    last_error TEXT NOT NULL DEFAULT '',
    collected INTEGER NOT NULL DEFAULT 0,
    primed BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX feeds_due ON feeds(next_check_at) WHERE enabled;
CREATE TABLE feed_entries (
    feed_id UUID NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
    entry_key TEXT NOT NULL,
    link TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    job_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(feed_id, entry_key)
);
