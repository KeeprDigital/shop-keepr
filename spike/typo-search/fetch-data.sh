#!/usr/bin/env bash
# Re-fetches the four card-name corpora. `data/` is committed, so this is only
# needed to refresh them. Every source is public and unauthenticated; nothing here
# provisions an account or spends money. Fetched for the findings on 2026-09-08.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE/data"

echo "==> Magic: Scryfall catalog/card-names (complete)"
curl -sS -A "shop-keepr-research/1.0" \
  "https://api.scryfall.com/catalog/card-names" -o scryfall-card-names.json

echo "==> Pokemon: api.pokemontcg.io (RATE-LIMITED; expect gaps)"
# The unauthenticated endpoint 502s under load. Pages that fail are skipped and
# the resulting corpus is a sample, which the findings state explicitly.
for p in $(seq 1 40); do
  curl -sS --retry 8 --retry-delay 10 --retry-all-errors -m 60 \
    "https://api.pokemontcg.io/v2/cards?pageSize=250&page=$p&select=name" -o "ptcg-$p.json" || true
done
node --input-type=module -e "
import { readFileSync, writeFileSync } from 'node:fs';
const s = new Set(); let ok = 0, bad = 0;
for (let p = 1; p <= 40; p++) {
  try { const d = JSON.parse(readFileSync('ptcg-' + p + '.json', 'utf8')); if (!d.data) throw 0; ok++; for (const c of d.data) s.add(c.name); }
  catch { bad++; }
}
console.log('  pages ok', ok, 'failed', bad, '-> distinct names', s.size);
writeFileSync('pokemon-card-names.json', JSON.stringify([...s].sort()));
"

echo "==> One Piece: Bandai's official English card list, all series (complete)"
curl -sS -m 25 "https://en.onepiece-cardgame.com/cardlist/?series=569201" -o op-index.html
grep -o '<option value="[0-9]*"' op-index.html | grep -o '[0-9]*' | sort -u > op-series.txt
: > op-all.html
while read -r s; do curl -sS -m 25 "https://en.onepiece-cardgame.com/cardlist/?series=$s" >> op-all.html; done < op-series.txt
node --input-type=module -e "
import { readFileSync, writeFileSync } from 'node:fs';
const h = readFileSync('op-all.html', 'utf8');
const dec = s => s.replace(/&amp;/g, '&').replace(/&#0?39;/g, \"'\").replace(/&quot;/g, '\"')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#x27;/g, \"'\");
const names = [...new Set([...h.matchAll(/class=\"cardName\">([^<]*)</g)].map(m => dec(m[1]).trim()).filter(Boolean))].sort();
console.log('  entries', (h.match(/class=\"cardName\"/g) || []).length, '-> distinct names', names.length);
writeFileSync('one-piece-card-names.json', JSON.stringify(names));
"
rm -f op-index.html op-series.txt op-all.html   # 14 MB of HTML, not committed

echo "==> Riftbound: PROXY. Riot Data Dragon champion names, not Riftbound cards."
VER=$(curl -sS "https://ddragon.leagueoflegends.com/api/versions.json" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d)[0]))")
echo "  Data Dragon $VER"
curl -sS "https://ddragon.leagueoflegends.com/cdn/$VER/data/en_US/champion.json" -o ddragon-champion.json
node --input-type=module -e "
import { readFileSync, writeFileSync } from 'node:fs';
const d = JSON.parse(readFileSync('ddragon-champion.json', 'utf8'));
const names = Object.values(d.data).map(c => c.name).sort();
console.log('  version', d.version, '-> champions', names.length);
writeFileSync('riot-champion-names.json', JSON.stringify(names));
"

echo "==> merged corpus"
node --input-type=module -e "
import { writeFileSync } from 'node:fs';
const { loadCorpora, allNames } = await import('$HERE/corpus.mjs');
const n = allNames(loadCorpora());
writeFileSync('$HERE/data/all-card-names.json', JSON.stringify(n));
console.log('  all-card-names.json:', n.length, 'distinct names');
"
