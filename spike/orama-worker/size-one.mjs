/** One size per process — Orama's persist() recursion is sensitive to prior heap state. */
import { readFileSync } from 'node:fs';
import { create, insertMultiple } from '@orama/orama';
import { persist } from '@orama/plugin-data-persistence';
const n = Number(process.argv[2]);
const withFilters = process.argv[3] === 'filters';
const names = JSON.parse(readFileSync(new URL('../typo-search/data/all-card-names.json', import.meta.url), 'utf8'));
const schema = withFilters ? { name: 'string', game: 'enum', rarity: 'enum', sellPrice: 'number', quantity: 'number' } : { name: 'string' };
const mem = () => Math.round(process.memoryUsage().heapUsed / 1e6);
const db = create({ schema });
const docs = Array.from({ length: n }, (_, i) => withFilters
  ? { id: `p-${String(i).padStart(7,'0')}`, name: names[i % names.length], game: ['magic','pokemon','onepiece','riftbound'][i%4], rarity: ['common','uncommon','rare','mythic'][i%4], sellPrice: (i*37)%50000, quantity: i%7 }
  : { id: `p-${String(i).padStart(7,'0')}`, name: names[i % names.length] });
const t = Date.now();
await insertMultiple(db, docs, 5000);
const ms = Date.now() - t;
global.gc?.();
const heap = mem();
let persisted = 'FAILED';
try { persisted = (Buffer.byteLength(await persist(db,'json'),'utf8')/1e6).toFixed(1); } catch (e) { persisted = `FAILED: ${e.message.slice(0,40)}`; }
console.log(`${String(n).padStart(7)}  ${(withFilters?'name+filters':'name only').padEnd(13)}  build ${String(ms).padStart(5)} ms  heap ${String(heap).padStart(4)} MB  persisted ${persisted} MB`);
