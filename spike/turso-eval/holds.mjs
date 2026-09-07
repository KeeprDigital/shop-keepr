// Re-run issue #4's oversell scenario against libSQL, three ways:
//   1. naive read-then-write (negative control; must oversell)
//   2. interactive transaction, BEGIN IMMEDIATE (the thing D1 cannot do)
//   3. the D1 single conditional statement (must still work)
import { createClient } from '@libsql/client';
import { rmSync } from 'node:fs';

const RACERS = 25;
const ITERATIONS = 40;
const STOCK = 1;

const RESERVE_SQL = `
INSERT INTO hold (inventory_item_id, basket_id, quantity, expires_at)
SELECT ?1, ?2, ?3, ?4
WHERE (SELECT on_hand FROM inventory_item WHERE id = ?1)
    - COALESCE((SELECT SUM(quantity) FROM hold
                WHERE inventory_item_id = ?1 AND expires_at > ?5), 0) >= ?3
`;

function fresh(path) {
	for (const s of ['', '-wal', '-shm']) rmSync(path + s, { force: true });
	return createClient({ url: `file:${path}` });
}

async function seed(db, iter) {
	await db.execute(`DELETE FROM hold`);
	await db.execute({ sql: `INSERT OR REPLACE INTO inventory_item VALUES (?, ?)`, args: [`i${iter}`, STOCK] });
}

async function setup(db) {
	await db.execute(`CREATE TABLE IF NOT EXISTS inventory_item (id TEXT PRIMARY KEY, on_hand INTEGER NOT NULL)`);
	await db.execute(`CREATE TABLE IF NOT EXISTS hold (
		id INTEGER PRIMARY KEY, inventory_item_id TEXT NOT NULL, basket_id TEXT NOT NULL,
		quantity INTEGER NOT NULL, expires_at INTEGER NOT NULL)`);
	await db.execute(`CREATE INDEX IF NOT EXISTS hold_item_exp ON hold (inventory_item_id, expires_at)`);
}

const PATH = '/tmp/holds-libsql.db';

async function granted(db, item) {
	const r = await db.execute({ sql: `SELECT COALESCE(SUM(quantity),0) AS q FROM hold WHERE inventory_item_id = ?`, args: [item] });
	return Number(r.rows[0].q);
}

async function scenario(name, attempt) {
	const clients = Array.from({ length: RACERS }, () => createClient({ url: `file:${PATH}` }));
	const admin = createClient({ url: `file:${PATH}` });
	let oversold = 0; let totalGranted = 0; let errors = 0;
	const t0 = performance.now();
	for (let iter = 0; iter < ITERATIONS; iter++) {
		await seed(admin, iter);
		const item = `i${iter}`;
		const now = Date.now();
		const results = await Promise.all(clients.map((c, k) =>
			attempt(c, item, `b${k}`, now).catch(() => { errors++; return null; })));
		void results;
		const g = await granted(admin, item);
		totalGranted += g;
		if (g > STOCK) oversold++;
	}
	const ms = performance.now() - t0;
	console.log(`${name.padEnd(34)} oversold ${String(oversold).padStart(3)}/${ITERATIONS} iters  granted/iter ${(totalGranted / ITERATIONS).toFixed(2)}  errors ${String(errors).padStart(4)}  ${(ms / ITERATIONS).toFixed(1)} ms/iter`);
	return { oversold, errors };
}

const naive = async (c, item, basket, now) => {
	const r = await c.execute({ sql: `SELECT on_hand - COALESCE((SELECT SUM(quantity) FROM hold WHERE inventory_item_id = ? AND expires_at > ?),0) AS avail FROM inventory_item WHERE id = ?`, args: [item, now, item] });
	if (Number(r.rows[0].avail) < 1) return false;
	await c.execute({ sql: `INSERT INTO hold (inventory_item_id, basket_id, quantity, expires_at) VALUES (?,?,1,?)`, args: [item, basket, now + 60000] });
	return true;
};

const interactive = async (c, item, basket, now) => {
	const tx = await c.transaction('write');
	try {
		const r = await tx.execute({ sql: `SELECT on_hand - COALESCE((SELECT SUM(quantity) FROM hold WHERE inventory_item_id = ? AND expires_at > ?),0) AS avail FROM inventory_item WHERE id = ?`, args: [item, now, item] });
		if (Number(r.rows[0].avail) < 1) { await tx.rollback(); return false; }
		await tx.execute({ sql: `INSERT INTO hold (inventory_item_id, basket_id, quantity, expires_at) VALUES (?,?,1,?)`, args: [item, basket, now + 60000] });
		await tx.commit();
		return true;
	}
	catch (e) { try { await tx.rollback(); } catch { /* already closed */ } throw e; }
};

const conditional = async (c, item, basket, now) => {
	const r = await c.execute({ sql: RESERVE_SQL, args: [item, basket, 1, now + 60000, now] });
	return r.rowsAffected > 0;
};

const boot = fresh(PATH);
await setup(boot);
console.log(`libSQL local file, ${RACERS} concurrent clients, stock=${STOCK}, ${ITERATIONS} iterations\n`);
await scenario('1. naive read-then-write', naive);
await scenario('2. interactive tx (BEGIN IMMEDIATE)', interactive);
await scenario('3. single conditional statement', conditional);
