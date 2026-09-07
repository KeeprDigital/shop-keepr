SELECT id, name FROM catalogue_printing
WHERE search_tsv @@ to_tsquery('simple', 'sentinel')
ORDER BY ts_rank(search_tsv, to_tsquery('simple', 'sentinel')) DESC
LIMIT 20;
