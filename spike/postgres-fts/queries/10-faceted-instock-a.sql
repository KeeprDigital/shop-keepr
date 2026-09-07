SELECT p.id, p.name, p.set_code, p.rarity, s.condition, s.quantity, s.sell_price
FROM stock s JOIN catalogue_printing p ON p.id = s.printing_id
WHERE s.store_id = 'store-a' AND s.quantity > 0
  AND p.game_system = 'magic' AND p.rarity = 'common' AND p.colour_identity = 'U'
ORDER BY s.sell_price ASC
LIMIT 20 OFFSET 40;
