// Run ONE probe per process so a segfault is attributable.
import { connect } from '@tursodatabase/database';
import { rmSync } from 'node:fs';

const sql = process.argv[2];
rmSync('/tmp/t1.db', { force: true });
rmSync('/tmp/t1.db-wal', { force: true });
const db = await connect('/tmp/t1.db');
await db.exec(`CREATE TABLE base (id INTEGER PRIMARY KEY, name TEXT)`);
await db.exec(`INSERT INTO base VALUES (1,'Thundering Sentinel')`);
try {
	const r = await db.prepare(sql).all();
	console.log(`OK${r?.[0] ? ` -> ${JSON.stringify(r[0])}` : ''}`);
}
catch (e) { console.log(`FAIL: ${String(e.message ?? e).slice(0, 140)}`); }
