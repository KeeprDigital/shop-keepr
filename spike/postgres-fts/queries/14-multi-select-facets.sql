SELECT id, name, set_code, rarity, market_price
FROM catalogue_printing
WHERE game_system = 'magic' AND rarity IN ('common','uncommon') AND colour_identity IN ('U','UB','WU')
ORDER BY name
LIMIT 20 OFFSET 40;
