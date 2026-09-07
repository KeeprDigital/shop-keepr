// Does libSQL's FTS5 carry the surface the D1 spike measured on D1?
// Ranking, highlighting and query syntax, not just "the module loads".
import { createClient } from '@libsql/client';

const db = createClient({ url: ':memory:' });
await db.execute(`CREATE VIRTUAL TABLE ft USING fts5(name, tokenize='porter unicode61')`);
await db.execute(`INSERT INTO ft(name) VALUES ('Thundering Sentinel of Storms')`);

const PROBES = [
	['bm25()', `SELECT bm25(ft) AS r FROM ft WHERE ft MATCH 'sentinel'`],
	['rank', `SELECT rank AS r FROM ft WHERE ft MATCH 'sentinel' ORDER BY rank`],
	['snippet()', `SELECT snippet(ft,0,'<b>','</b>','…',8) AS r FROM ft WHERE ft MATCH 'sentinel'`],
	['highlight()', `SELECT highlight(ft,0,'<b>','</b>') AS r FROM ft WHERE ft MATCH 'sentinel'`],
	['prefix query sent*', `SELECT name AS r FROM ft WHERE ft MATCH 'sent*'`],
	['phrase query', `SELECT name AS r FROM ft WHERE ft MATCH '"of storms"'`],
];

for (const [label, sql] of PROBES) {
	try {
		const x = await db.execute(sql);
		console.log(`${label.padEnd(20)}OK -> ${JSON.stringify(x.rows[0])}`);
	}
	catch (e) { console.log(`${label.padEnd(20)}FAIL: ${String(e.message).slice(0, 80)}`); }
}
