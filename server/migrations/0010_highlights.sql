CREATE TABLE highlights (
    id UUID PRIMARY KEY,
    item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    quote TEXT NOT NULL CHECK(length(quote) BETWEEN 1 AND 5000),
    prefix TEXT NOT NULL DEFAULT '',
    suffix TEXT NOT NULL DEFAULT '',
    start_offset INTEGER NOT NULL CHECK(start_offset >= 0),
    color TEXT NOT NULL DEFAULT 'yellow' CHECK(color IN ('yellow','green','blue','pink','purple')),
    note TEXT NOT NULL DEFAULT '' CHECK(length(note) <= 20000),
    revision BIGINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX highlights_item ON highlights(item_id, start_offset);
