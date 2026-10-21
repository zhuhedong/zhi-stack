-- CJK-aware search prefilter without extensions. pg_trgm cannot index terms
-- shorter than three characters and Chinese words are usually one or two, so
-- item_search also keeps the distinct CJK unigrams and bigrams of the text in
-- an array with a built-in GIN index. A query term's grams must all be present
-- (array containment), then the existing LIKE + application scoring verifies
-- adjacency. Works on stock postgres:17-alpine; zhparser/pg_jieba not needed.
-- Linear-time: unigrams from one regex pass; bigrams as non-overlapping pairs
-- of each run plus the pairs of the run shifted by one character.
CREATE OR REPLACE FUNCTION infohub_cjk_grams(t TEXT) RETURNS TEXT[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT COALESCE(array_agg(DISTINCT g), '{}') FROM (
        SELECT (regexp_matches(t, '[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]', 'g'))[1] AS g
        UNION ALL
        SELECT (regexp_matches(r.run, '..', 'g'))[1]
          FROM (SELECT (regexp_matches(t, '[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]{2,}', 'g'))[1] AS run) r
        UNION ALL
        SELECT (regexp_matches(substr(r.run, 2), '..', 'g'))[1]
          FROM (SELECT (regexp_matches(t, '[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]{3,}', 'g'))[1] AS run) r
    ) grams
$$;

-- Grams are computed from at most 200k characters. Longer texts additionally
-- carry the '*' marker, which queries always accept, so nothing is missed.
CREATE OR REPLACE FUNCTION infohub_search_grams(body TEXT) RETURNS TEXT[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT infohub_cjk_grams(left(body, 200000))
           || CASE WHEN char_length(body) > 200000 THEN ARRAY['*'] ELSE '{}'::TEXT[] END
$$;

ALTER TABLE item_search ADD COLUMN grams TEXT[] NOT NULL DEFAULT '{}';

CREATE OR REPLACE FUNCTION infohub_item_search_sync() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    body TEXT := infohub_search_text(NEW.title, NEW.project, NEW.summary, NEW.url,
                                     NEW.category, NEW.tags, NEW.data);
BEGIN
    INSERT INTO item_search(item_id, text, grams)
    VALUES (NEW.id, body, infohub_search_grams(body))
    ON CONFLICT (item_id) DO UPDATE SET text = EXCLUDED.text, grams = EXCLUDED.grams;
    RETURN NULL;
END $$;

UPDATE item_search SET grams = infohub_search_grams(text);

CREATE INDEX item_search_grams ON item_search USING GIN (grams);
