/**
 * The catalogue's identifier grammars, as SQL literals.
 *
 * `@oxyhq/contracts` declares these patterns for the WIRE (`publisherSlugSchema`,
 * `modelSlugSchema`, `modelRevisionLabelSchema` in `inference/identifiers.ts`).
 * They are restated here for the DATABASE, and the restatement is deliberate
 * rather than duplication that got missed:
 *
 *  - A zod regex is a JavaScript `RegExp`; a CHECK constraint needs a POSIX ARE
 *    literal. They are different languages, so there is no single string both
 *    sides could share, and `RegExp.source` is not a safe thing to interpolate
 *    into DDL.
 *  - The two must nonetheless agree, so `schema/__tests__/inferenceCatalogue.test.ts`
 *    asserts it in BOTH directions against real rows: every string the contract
 *    accepts must insert, and every string it rejects must be refused by the
 *    database. Neither side can be widened alone.
 *
 * Why the database needs its own copy at all: a route handler's validation is
 * bypassable by a seed script, a backfill or a `psql` session, and a slug
 * containing `/` would make `<publisher>/<model>` ambiguous — `a/b/c` has two
 * readings — with the damage only surfacing when a customer's pinned model id
 * stopped resolving.
 *
 * These strings are interpolated with `sql.raw`, which is safe ONLY because they
 * are module constants written here. Never build one from a runtime value: a
 * CHECK cannot carry a bound parameter, so an interpolated `$1` lands in the
 * generated migration verbatim and fails at APPLY time.
 */

/**
 * One path segment of a canonical model id — lowercase, URL-safe, no leading or
 * trailing separator. Mirrors `SLUG_PATTERN` in `@oxyhq/contracts`.
 *
 * Written as a single-quoted SQL string literal, ready for `sql.raw`.
 */
export const SLUG_CHECK_PATTERN = String.raw`'^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$'`;

/**
 * An immutable revision label. Case-PRESERVING, because upstream revision names
 * routinely are (`2026-05-01`, `v1.2-Instruct`). Mirrors `REVISION_PATTERN`.
 */
export const REVISION_CHECK_PATTERN = String.raw`'^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$'`;

/**
 * A model reference as a customer writes it: `<publisher>/<model>` or
 * `<publisher>/<model>@<revision>`. Mirrors `modelReferenceSchema`.
 *
 * Used where a reference is stored as a plain string rather than resolved
 * through the catalogue's own foreign keys — a routing profile's replacement
 * pointer, for instance, may legitimately name a model this catalogue does not
 * hold yet.
 */
export const MODEL_REFERENCE_CHECK_PATTERN = String.raw`'^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?:@[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?)?$'`;
