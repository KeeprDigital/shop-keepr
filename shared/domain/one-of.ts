/** Type guard for membership of a closed `as const` list. */
export function isOneOf<const T extends readonly string[]>(list: T, value: unknown): value is T[number] {
	return typeof value === 'string' && (list as readonly string[]).includes(value);
}
