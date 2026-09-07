/**
 * Throwaway spike (issue #13): the queries under test.
 *
 * These are written the way the storefront would write them, not the way that
 * flatters the numbers. "Blue commons we have in stock, cheapest first, page 3"
 * is the sentence issue #6 says must be computable in one query; it is
 * `FACETED_IN_STOCK` below.
 */

/** Catalogue browse: no stock involved. The kiosk's "browse Magic commons" path. */
export const FACETED_BROWSE = `
SELECT id, name, set_code, rarity, market_price
FROM catalogue_printing
WHERE game_system = ?1 AND rarity = ?2 AND colour_identity = ?3
ORDER BY name
LIMIT 20 OFFSET 40
`;

/** The query issue #6 rests on: facets from the mirror, availability and price from stock, sorted by the store's own price. */
export const FACETED_IN_STOCK = `
SELECT p.id, p.name, p.set_code, p.rarity, s.condition, s.quantity, s.sell_price
FROM stock s
JOIN catalogue_printing p ON p.id = s.printing_id
WHERE s.store_id = ?1
  AND s.quantity > 0
  AND p.game_system = ?2
  AND p.rarity = ?3
  AND p.colour_identity = ?4
ORDER BY s.sell_price ASC
LIMIT 20 OFFSET 40
`;

/** Same result set, but with available-to-promise computed inline — on-hand minus live Holds, per #6. */
export const FACETED_IN_STOCK_ATP = `
SELECT p.id, p.name, s.condition, s.sell_price,
       s.quantity - COALESCE((SELECT SUM(h.quantity) FROM hold h
                              WHERE h.stock_id = s.id AND h.expires_at > ?5), 0) AS available
FROM stock s
JOIN catalogue_printing p ON p.id = s.printing_id
WHERE s.store_id = ?1
  AND p.game_system = ?2
  AND p.rarity = ?3
  AND p.colour_identity = ?4
  AND s.quantity - COALESCE((SELECT SUM(h.quantity) FROM hold h
                             WHERE h.stock_id = s.id AND h.expires_at > ?5), 0) > 0
ORDER BY s.sell_price ASC
LIMIT 20 OFFSET 40
`;

/** The same facets against the denormalised store-owned table: no join to the mirror at all. */
export const FACETED_DENORM = `
SELECT printing_id, condition, quantity, sell_price
FROM stock_denorm
WHERE store_id = ?1 AND game_system = ?2 AND rarity = ?3 AND colour_identity = ?4 AND quantity > 0
ORDER BY sell_price ASC
LIMIT 20 OFFSET 40
`;

/** The result count a paginated UI wants next to the results. */
export const FACET_COUNT = `
SELECT COUNT(*) AS n
FROM catalogue_printing
WHERE game_system = ?1 AND rarity = ?2 AND colour_identity = ?3
`;

export const FACET_COUNT_IN_STOCK = `
SELECT COUNT(*) AS n
FROM stock s JOIN catalogue_printing p ON p.id = s.printing_id
WHERE s.store_id = ?1 AND s.quantity > 0
  AND p.game_system = ?2 AND p.rarity = ?3 AND p.colour_identity = ?4
`;

/** Deep pagination: the same query, far down the result set. */
export const FACETED_BROWSE_DEEP = FACETED_BROWSE.replace('OFFSET 40', 'OFFSET 2000');

/** Multi-select facets, as a real filter UI offers. */
export const FACETED_BROWSE_MULTI = `
SELECT id, name, set_code, rarity, market_price
FROM catalogue_printing
WHERE game_system = ?1 AND rarity IN ('common', 'uncommon') AND colour_identity IN ('U', 'UB', 'WU')
ORDER BY name
LIMIT 20 OFFSET 40
`;

/** Name search, three ways. */
export const NAME_LIKE_PREFIX = `
SELECT id, name FROM catalogue_printing
WHERE game_system = ?1 AND name LIKE ?2
ORDER BY name LIMIT 20
`;

export const NAME_LIKE_SUBSTRING = `
SELECT id, name FROM catalogue_printing
WHERE game_system = ?1 AND name LIKE ?2
ORDER BY name LIMIT 20
`;

export const NAME_FTS = `
SELECT p.id, p.name
FROM catalogue_fts f
JOIN catalogue_printing p ON p.rowid = f.rowid
WHERE catalogue_fts MATCH ?1
ORDER BY rank
LIMIT 20
`;

/** Name search fused with the facets and with stock — the staff Buy-entry and kiosk search path combined. */
export const NAME_FTS_FACETED_IN_STOCK = `
SELECT p.id, p.name, s.condition, s.sell_price
FROM catalogue_fts f
JOIN catalogue_printing p ON p.rowid = f.rowid
JOIN stock s ON s.printing_id = p.id
WHERE catalogue_fts MATCH ?1
  AND s.store_id = ?2
  AND s.quantity > 0
  AND p.game_system = ?3
ORDER BY s.sell_price ASC
LIMIT 20
`;

/** A full scan, used to check that `rows_read` is actually being measured. */
export const FULL_SCAN_CONTROL = `
SELECT COUNT(*) AS n FROM catalogue_printing WHERE image_uri LIKE '%zzzzzz%'
`;
