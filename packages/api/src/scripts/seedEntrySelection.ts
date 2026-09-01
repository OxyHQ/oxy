/**
 * Bound a seed run to an explicit subset of a canonical list.
 *
 * Two scripts reconcile a canonical list against production and both carry the
 * same hazard: the run touches EVERY entry unless somebody says otherwise, and
 * several of the fields they reconcile are authoritative. Registering ONE new
 * entry otherwise carries the blast radius of all the others. Naming the entries
 * a run may touch removes that blast radius instead of merely warning about it,
 * and the invocation itself becomes the audit record.
 *
 *  - `scripts/seed-oxy-applications.ts` bounds on `ONLY_APPS`.
 *  - `scripts/seed-internal-cost-centers.ts` bounds on `ONLY_COST_CENTERS`,
 *    where each entry is a real ACCOUNT this run may mint.
 *
 * FAILS CLOSED, deliberately. Every rejection below could instead have been
 * "quietly reconcile nothing", and that is the same failure shape as a dry run
 * reporting zero changes before a real run changes something — a no-op that
 * reads as success, which the next operator then trusts. So:
 *
 *  - An unset value means "the whole canonical list".
 *  - A SET but empty / whitespace-only value throws. It is never read as "all":
 *    the dangerous misreading is an operator who meant to bound the run, passed
 *    a variable that happened to be empty, and got the full-blast-radius run.
 *  - An unknown name throws and names both what it could not match and what it
 *    could have — a typo must not silently shrink the run to nothing (or, worse,
 *    to some other entry).
 *
 * Pure and dependency-free (no database, no env access) so the decision is unit
 * testable, mirroring `registerCommonsClientsPlan.ts`.
 */

/** The only thing this module needs of a seed entry: its idempotency key. */
export interface NamedSeedEntry {
  name: string;
}

/**
 * How a refusal names the thing it refused.
 *
 * Passed rather than hardcoded because the two callers seed different kinds of
 * record, and an error that says "application" while an operator is seeding cost
 * centres sends them to the wrong script. The env var travels with them for the
 * same reason: the message has to name the variable the operator actually set.
 */
export interface SeedEntryVocabulary {
  /** The environment variable the raw value came from, e.g. `ONLY_APPS`. */
  envVar: string;
  /** Singular noun, e.g. `application`. */
  singular: string;
  /** Plural noun, e.g. `applications`. */
  plural: string;
}

/**
 * Resolve the seed entries a run may touch.
 *
 * @param entries The canonical seed list, in canonical order.
 * @param raw The raw env value: `undefined` when unset, or a comma-separated
 *   list of entry names to restrict the run to.
 * @param vocabulary How a refusal should name what it refused.
 * @returns The selected entries, in the canonical list's own order (never the
 *   order they were requested in — the seed's behaviour must not depend on how
 *   an operator happened to type the filter).
 * @throws When `raw` is set but selects nothing, or names an entry that is not
 *   in `entries`.
 */
export function selectSeedEntries<T extends NamedSeedEntry>(
  entries: readonly T[],
  raw: string | undefined,
  vocabulary: SeedEntryVocabulary
): T[] {
  if (raw === undefined) {
    return [...entries];
  }

  const requested = raw
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

  if (requested.length === 0) {
    throw new Error(
      `${vocabulary.envVar} was set but names no ${vocabulary.singular}. Unset it to seed ` +
        `every ${vocabulary.singular}, or name the ones this run may touch — it is never ` +
        'read as "all".'
    );
  }

  // Exact, case-sensitive match: `name` IS the idempotency key, so a near-miss
  // is a different entry, not this one.
  const known = new Set(entries.map((entry) => entry.name));
  const unknown = requested.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `${vocabulary.envVar} names unknown ${vocabulary.singular}(s): [${unknown.join(', ')}]. ` +
        `Known ${vocabulary.plural}: [${entries.map((entry) => entry.name).join(', ')}].`
    );
  }

  const selected = new Set(requested);
  return entries.filter((entry) => selected.has(entry.name));
}
