/**
 * The Mirror's indexes, built by the run's finish step rather than the
 * migration: each `CREATE INDEX` multiplies the rows written per Printing,
 * so they wait until after a seed (spec §4.5). `IF NOT EXISTS` makes every
 * later run a no-op. The per-game search tables bring their own index sets
 * (spec §4.2; ADR 0008).
 */
export const MIRROR_INDEXES: readonly string[] = [
	/** Every Printing of a Card, for the cross-game screens that group by Card. */
	'CREATE INDEX IF NOT EXISTS printing_card ON printing (card_id)',
	/** A Printing by its set and collector number, as staff read it off the card. */
	'CREATE INDEX IF NOT EXISTS printing_game_set_number ON printing (game_system, set_code, collector_number)',
];
