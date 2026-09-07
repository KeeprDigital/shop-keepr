SELECT id, name FROM catalogue_printing
WHERE search_tsv @@ to_tsquery('simple', 'sent:*')
LIMIT 20;
