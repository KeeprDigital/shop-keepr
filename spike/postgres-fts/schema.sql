-- Throwaway spike (issue #19): the Postgres side of the comparison.
--
-- Deliberately a column-for-column transliteration of `spike/d1-search/schema.ts`,
-- including the two schema-discipline decisions #2 took specifically to keep this
-- port cheap: money as integer minor units, timestamps as epoch-ms integers.
-- Nothing here uses NUMERIC or timestamptz, because the point is to measure the
-- port that actually exists, not a redesign.

DROP TABLE IF EXISTS stock;
DROP TABLE IF EXISTS catalogue_printing;

CREATE TABLE catalogue_printing (
  id               TEXT PRIMARY KEY,
  game_system      TEXT NOT NULL,
  name             TEXT NOT NULL,
  set_code         TEXT NOT NULL,
  set_name         TEXT NOT NULL,
  collector_number TEXT NOT NULL,
  rarity           TEXT NOT NULL,
  finish           TEXT NOT NULL,
  language         TEXT NOT NULL,
  colour_identity  TEXT,
  type_line        TEXT,
  subtype          TEXT,
  mana_value       INTEGER,
  market_price     INTEGER,
  image_uri        TEXT NOT NULL,
  released_at      BIGINT NOT NULL
);

CREATE TABLE stock (
  id          BIGSERIAL PRIMARY KEY,
  store_id    TEXT NOT NULL,
  printing_id TEXT NOT NULL,
  condition   TEXT NOT NULL,
  quantity    INTEGER NOT NULL,
  sell_price  INTEGER NOT NULL,
  buy_price   INTEGER NOT NULL
);
