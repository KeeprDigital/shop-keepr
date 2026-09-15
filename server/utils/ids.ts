import { ulid } from 'ulidx';

/** New opaque ULID for a row id; generated in app code, never by D1 (spec §4.1). */
export function newId(): string {
	return ulid();
}
