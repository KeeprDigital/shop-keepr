SELECT p.id, p.name, s.condition, s.sell_price
FROM catalogue_printing p
JOIN stock s ON s.printing_id = p.id
WHERE p.search_tsv @@ to_tsquery('simple', 'sentinel')
  AND s.store_id = 'store-a'
  AND s.quantity > 0
  AND p.game_system = 'magic'
ORDER BY s.sell_price ASC
LIMIT 20;
