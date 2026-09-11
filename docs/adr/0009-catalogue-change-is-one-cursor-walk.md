---
status: accepted
---

# Catalogue change arrives through one cursor walk; seed, delta and reconcile are the same run

shop-keepr requires one change-delivery shape from the Catalogue: a paged endpoint per Game System, ordered by an **opaque, monotonic, exhaustive cursor** the Catalogue issues, returning full records — Printings with their Market Price, sets, vocabularies — with a withdrawal arriving as a record flagged `withdrawn`, never as absence. The mirror is filled, kept current and healed by **one job walking that cursor**: a seed is the walk from cursor zero into an empty mirror, a delta is the walk from the last cursor, a reconcile is the walk from cursor zero into a full mirror. Every write compares a content hash first, which is what lets all three be one code path. Decided in [#14](https://github.com/KeeprDigital/shop-keepr/issues/14).

The surprise this records: the Catalogue _has_ a notion of atomic, immutable per-game Revisions, and shop-keepr deliberately does not consume it.

## Considered options

**Immutable per-game Revisions, diffed locally.** Each Revision is a complete snapshot; shop-keepr downloads it and works out what changed. Atomic and trivially idempotent, but every delta is a full download and a full compare, and the seed, the delta and the reconcile become three differently-shaped consumers of one artefact. Rejected: the atomicity buys nothing the mirror needs, since a Printing seen twice mid-walk is an upsert either way.

**A wall-clock `updated_at` filter.** The obvious cursor, and the one the Market Price requirement first asked for. Rejected as the _wire_ contract because a timestamp only means "nothing at or before this arrives later" if the Catalogue guarantees it: a slow write that commits with an earlier stamp after the reader has passed it, or two changes sharing a millisecond across a page boundary, silently lose records. The Catalogue may back the cursor with a timestamp plus a tiebreak; shop-keepr stores and returns it verbatim and never parses it.

**Both: a snapshot file for seed and reconcile, a cursor endpoint for delta.** Rejected as two contracts and two code paths where one does.

## Consequences

- **Two run kinds, not three.** A Catalogue run and a Market Price run ([#21](https://github.com/KeeprDigital/shop-keepr/issues/21)), each with its own cursor per Game System and its own cadence. Seed and reconcile are Catalogue runs with `fromCursor = 0`.
- **Rebuild never truncates.** Because every write is hash-compared, a full walk against a live mirror is safe, and a bad release is undone by walking again.
- **Absence is not withdrawal.** A Printing the mirror holds that a full walk does not return is recorded as drift, not flipped to withdrawn. Only a record says withdrawn.
- **The Printing record carries its Market Price**, so a Printing arrives priced and the Market Price run only ever carries movements. A price movement for a Printing the mirror does not hold is skipped and counted.
- **Run isolation is the point of two runs.** A quarantined Catalogue record, or a run that fails, never stalls the Market Price run.
- **A record that cannot be applied is quarantined; the run never fails.** _(Amended by [#14](https://github.com/KeeprDigital/shop-keepr/issues/14).)_ A record that fails schema validation, or carries a vocabulary value that needs a column of its own (a new colour), is written to a quarantine table with its raw payload and the run completes `completed_with_drift`, with the count and reason on the staff banner. A new Magic colour must not freeze Pokémon prices. Quarantined records clear themselves: the next reconcile re-reads them and they validate once the release lands. This supersedes the earlier rule that an unrecognised value fails the sync loudly ([#15](https://github.com/KeeprDigital/shop-keepr/issues/15)).
