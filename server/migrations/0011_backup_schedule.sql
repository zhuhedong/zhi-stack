-- Unattended backups. Operational state, not part of backups themselves.
CREATE TABLE backup_schedule (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    enabled BOOLEAN NOT NULL DEFAULT false,
    interval_hours INTEGER NOT NULL DEFAULT 24 CHECK(interval_hours BETWEEN 1 AND 720),
    keep INTEGER NOT NULL DEFAULT 7 CHECK(keep BETWEEN 1 AND 100),
    targets TEXT[] NOT NULL DEFAULT '{storage}',
    -- Backup key = Argon2(master password, salt), wrapped with the server's service key.
    salt BYTEA,
    wrapped_key BYTEA,
    next_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_run_at TIMESTAMPTZ,
    last_status TEXT NOT NULL DEFAULT '',
    last_message TEXT NOT NULL DEFAULT '',
    running BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE scheduled_backups (
    id UUID PRIMARY KEY,
    target TEXT NOT NULL CHECK(target IN ('storage','dir')),
    location TEXT NOT NULL,
    size BIGINT NOT NULL,
    sha256 TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX scheduled_backups_time ON scheduled_backups(target, created_at DESC);
