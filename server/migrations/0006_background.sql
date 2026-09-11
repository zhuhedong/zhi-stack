CREATE TABLE ingest_jobs (
    id UUID PRIMARY KEY,
    payload BYTEA NOT NULL,
    encrypted BOOLEAN NOT NULL,
    output BYTEA,
    status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','waiting_unlock','running','succeeded','failed','cancelled')),
    phase TEXT NOT NULL DEFAULT '等待执行',
    item_id UUID REFERENCES items(id) ON DELETE SET NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ingest_jobs_queue ON ingest_jobs(created_at) WHERE status IN ('queued','waiting_unlock');

CREATE TABLE repo_subscriptions (
    item_id UUID PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT true,
    interval_hours INTEGER NOT NULL DEFAULT 24 CHECK(interval_hours BETWEEN 1 AND 168),
    revision BIGINT NOT NULL DEFAULT 1,
    next_check_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_checked_at TIMESTAMPTZ,
    checking BOOLEAN NOT NULL DEFAULT false,
    last_error TEXT NOT NULL DEFAULT '',
    snapshot JSONB NOT NULL DEFAULT '{}',
    signature TEXT NOT NULL DEFAULT '',
    seen_signature TEXT NOT NULL DEFAULT ''
);
CREATE INDEX repo_subscriptions_due ON repo_subscriptions(next_check_at) WHERE enabled;
CREATE TABLE repo_checks (
    id UUID PRIMARY KEY,
    item_id UUID NOT NULL REFERENCES repo_subscriptions(item_id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK(status IN ('success','partial','failed')),
    snapshot JSONB NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX repo_checks_item_time ON repo_checks(item_id,created_at DESC);
