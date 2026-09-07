-- Throwaway spike (issue #19): indexes, applied after the bulk load as a real
-- seed would, so each one's build time and size can be attributed.
--
-- The B-tree set mirrors `spike/d1-search/schema.ts` one-for-one. The last three
-- are the Postgres-specific part under test: a generated tsvector column with a
-- GIN index (the tsvector/GIN claim in #19), and a pg_trgm GIN index (the
-- counterpart to D1's FTS5 trigram tokenizer).

\timing on

-- --- B-tree set, transliterated from the D1 spike -------------------------
CREATE INDEX cp_game_rarity ON catalogue_printing (game_system, rarity, name);
CREATE INDEX cp_game_colour ON catalogue_printing (game_system, colour_identity, rarity);
CREATE INDEX cp_game_set    ON catalogue_printing (game_system, set_code, collector_number);
CREATE INDEX cp_name        ON catalogue_printing (name);

CREATE UNIQUE INDEX stock_sku      ON stock (store_id, printing_id, condition);
CREATE INDEX        stock_price    ON stock (store_id, sell_price);
CREATE INDEX        stock_printing ON stock (printing_id);

-- --- Full text ------------------------------------------------------------
-- `simple` rather than `english`: the D1 spike measured FTS5's default
-- unicode61 tokenizer, which does not stem. Using `english` here would be
-- comparing a stemmer against a non-stemmer.
--
-- A GENERATED ... STORED column is the material difference from D1. The D1
-- spike proved an external-content FTS5 index does NOT follow its base table
-- (rename a row, the index keeps the old name, silently). Postgres maintains
-- this column in the same statement that writes the row; it cannot diverge.
ALTER TABLE catalogue_printing
  ADD COLUMN search_tsv tsvector
  GENERATED ALWAYS AS (
    to_tsvector('simple',
      coalesce(name, '') || ' ' || coalesce(set_name, '') || ' ' || coalesce(type_line, ''))
  ) STORED;

CREATE INDEX cp_search_gin ON catalogue_printing USING GIN (search_tsv);

-- --- Substring ------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX cp_name_trgm ON catalogue_printing USING GIN (name gin_trgm_ops);

-- --- Case-insensitive prefix ---------------------------------------------
-- The D1 spike's single most dangerous finding was that a parameterised
-- `name LIKE ?` prefix search does not use an index until the column carries a
-- COLLATE NOCASE index. Postgres has the identical trap in a different costume:
-- a default-collation B-tree cannot serve LIKE unless the index uses
-- text_pattern_ops. Both are measured.
CREATE INDEX cp_name_pattern ON catalogue_printing (name text_pattern_ops);

ANALYZE catalogue_printing;
ANALYZE stock;
