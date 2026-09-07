/**
 * Throwaway spike schema (issue #4). Timestamps are epoch-ms integers per the
 * data-layer decision in issue #2. One statement per array entry so it can be
 * fed to `D1Database.exec()`, which splits input on newlines.
 */
export const SCHEMA = [
	'DROP TABLE IF EXISTS hold;',
	'DROP TABLE IF EXISTS inventory_item;',
	'CREATE TABLE inventory_item (id TEXT PRIMARY KEY, on_hand INTEGER NOT NULL);',
	'CREATE TABLE hold (id INTEGER PRIMARY KEY AUTOINCREMENT, inventory_item_id TEXT NOT NULL, basket_id TEXT NOT NULL, quantity INTEGER NOT NULL, expires_at INTEGER NOT NULL);',
	'CREATE INDEX hold_item_expiry ON hold (inventory_item_id, expires_at);',
].join('\n');
