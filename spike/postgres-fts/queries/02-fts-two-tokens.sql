SELECT id, name FROM catalogue_printing
WHERE search_tsv @@ to_tsquery('simple', 'thundering & sentinel')
ORDER BY ts_rank(search_tsv, to_tsquery('simple', 'thundering & sentinel')) DESC
LIMIT 20;
