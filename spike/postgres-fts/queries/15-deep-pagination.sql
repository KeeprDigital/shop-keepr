SELECT id, name, set_code, rarity, market_price
FROM catalogue_printing
WHERE game_system = 'magic' AND rarity = 'common' AND colour_identity = 'U'
ORDER BY name
LIMIT 20 OFFSET 2000;
