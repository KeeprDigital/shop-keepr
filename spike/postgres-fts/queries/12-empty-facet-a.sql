SELECT p.id, p.name, s.condition, s.sell_price
FROM stock s JOIN catalogue_printing p ON p.id = s.printing_id
WHERE s.store_id = 'store-a' AND s.quantity > 0
  AND p.game_system = 'yugioh' AND p.rarity = 'secret-rare' AND p.colour_identity = 'WUBRG'
ORDER BY s.sell_price ASC
LIMIT 20 OFFSET 40;
