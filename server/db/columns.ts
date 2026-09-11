import type { Condition } from '../../shared/domain/condition';
import type { Language } from '../../shared/domain/language';
import type { Money } from '../../shared/domain/money';
import { integer, text } from 'drizzle-orm/sqlite-core';
import { CONDITIONS } from '../../shared/domain/condition';
import { LANGUAGES } from '../../shared/domain/language';

/**
 * Column builders that carry the storage conventions (spec §4.1) so every
 * table declares them the same way and the shared vocabulary is imported,
 * never restated:
 *
 * - ids are opaque ULIDs generated in app code (`newId()`), stored as text
 * - `store_id` is on every store-owned table, first in every composite index
 * - timestamps are epoch-ms integers; never hand D1 a `Date`
 * - Money is an integer of minor units (`minorUnits()`)
 * - Condition and Language are the closed lists from `shared/`
 */

export const ulid = () => text();

export const storeId = () => text('store_id').notNull();

export const epochMs = () => integer({ mode: 'number' });

export const minorUnits = () => integer({ mode: 'number' }).$type<Money>();

export const condition = () => text({ enum: CONDITIONS }).$type<Condition>();

export const language = () => text({ enum: LANGUAGES }).$type<Language>();
