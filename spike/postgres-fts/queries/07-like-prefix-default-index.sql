SELECT id, name FROM catalogue_printing
WHERE game_system = 'magic' AND name LIKE 'Thundering Sent%'
ORDER BY name LIMIT 20;
