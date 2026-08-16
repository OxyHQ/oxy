/**
 * `price_versions` + `price_version_unit_prices` — the immutable snapshots
 * customer pricing is quoted and settled against.
 *
 * New tables. Nothing is being ported: before this migration the only
 * price-like value anywhere in the package was `models-stats.ts`'s
 * `creditMultiplier`, a JavaScript float that no code read
 * (`docs/audits/2026-08-15-account-and-application-ownership.md` §1.2).
 *
 * ## A price is never edited; a change publishes a new version
 *
 * `draft` may be quoted in a Console preview and may never price a receipt;
 * `active` is what live requests are priced with; `superseded` priced receipts
 * in the past and still resolves for them forever. Retirement is
 * `status = 'superseded'` plus an `effective_until` — never a DELETE, which is
 * why every foreign key pointing here is `ON DELETE RESTRICT` and why that
 * `RESTRICT` should never fire in ordinary operation.
 *
 * ## Scoped to `(model_reference, provider)`, as plain text
 *
 * The same model costs different amounts on different providers, and a receipt
 * has to be reproducible against the route that actually served it. Both are
 * plain `text`, with NO foreign key into the model catalogue, and that is a
 * decision rather than a table that has not landed yet: a settled receipt must
 * stay reproducible after a revision is retired from the catalogue, and a
 * financial record must never become unwritable because a catalogue row moved.
 * Neither column is id-shaped, so no classification is owed for them.
 *
 * ## One active version per route
 *
 * A partial unique index, not a convention. Two `active` versions for one
 * `(model_reference, provider)` would make "what does this cost right now" a
 * question with two answers, and settlement would pick whichever the planner
 * returned first.
 *
 * ## The prices are a CHILD TABLE, not `jsonb`
 *
 * An array of entities with a fully known shape and a closed unit vocabulary —
 * `CONVENTIONS.md` puts that in a real table with real columns. It also makes a
 * receipt's arithmetic checkable in SQL: `sum(amount * quantity / per)` over the
 * snapshot is a query, not a re-implementation in application code.
 *
 * The child does NOT carry a currency. The contract's `unitPriceSchema` has
 * one, and its own refinement requires it to equal the version's — so storing
 * it here would be a duplicate that can disagree with its parent. The
 * serializer fills it from `price_versions.currency`.
 *
 * ## Who writes these — NOBODY, YET
 *
 * As of this commit there is **no writer for these tables anywhere in the
 * repository**. The ledger only READS them, to price a receipt; the rows a
 * settlement needs have to be inserted by hand or by a test fixture until an
 * authoring surface exists. That is a stated gap, not an omission somebody
 * should assume was filled elsewhere.
 *
 * The INTENDED home is the catalogue admin surface (#972 workstreams 5 and 11),
 * where the model revision and provider a price is scoped to already live —
 * intended, not existing: at the time of writing that surface manages
 * deployments and does not publish prices. Whichever surface eventually does,
 * the rule above is not negotiable: a PRICE change inserts a new row and
 * supersedes the old one, never an edit to what a published version costs.
 *
 * ## What is ENFORCED here, and what is only a rule — issue #996
 *
 * "An existing row is never edited" was the earlier wording and it is not what
 * this table can promise: superseding a version IS an update, of `status` and
 * `effective_until`, which is why `updated_at` exists here at all. So the whole
 * row cannot carry an immutability trigger the way `usage_receipts` and
 * `application_credential_audit_events` do — one would make the documented
 * `draft → active → superseded` retirement impossible.
 *
 * The narrower guard that WOULD fit is a column-scoped trigger freezing a
 * version's identity and its child prices once it leaves `draft`, in the shape
 * `inference_model_revision_identity_immutable` already uses. It is deliberately
 * not written yet, because nothing writes these tables (see above): it would
 * have to guess whether a draft's prices may be corrected before activation,
 * which is a decision belonging to the authoring surface that does not exist.
 * Write it WITH that surface, in the same change.
 *
 * Settled history does not wait on any of it. A receipt stores a COPY of the
 * unit prices it was settled against, in `usage_receipt_unit_prices`, and that
 * table is guarded by `0034_inference_ledger_immutability`. Editing a price
 * version cannot retroactively change what anyone was charged; it can only
 * change what the NEXT request costs, silently and with no new version to point
 * at. That is the exposure, and it is smaller than the audit trail's.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxyhq/db';
import {
  priceVersionStatusSchema,
  USAGE_UNITS,
} from '@oxyhq/contracts';
import {
  currencyCode,
  currencyCodeCheck,
  exactAmount,
} from './ledgerColumns';

/**
 * `draft | active | superseded`, taken from the wire contract's own enum rather
 * than restated, so the column and `priceVersionStatusSchema` cannot drift.
 */
export const PRICE_VERSION_STATUSES = priceVersionStatusSchema.options;

export const priceVersions = pgTable(
  'price_versions',
  {
    /**
     * This id IS the contract's `priceVersionId`. There is deliberately no
     * second, human-readable natural key beside it: a record a receipt points at
     * must have exactly one identity, or a reader eventually resolves the wrong
     * one.
     */
    id: generatedId(),

    status: text({ enum: PRICE_VERSION_STATUSES }).notNull().default('draft'),

    /** `<publisher>/<model>` or `<publisher>/<model>@<revision>`. */
    modelReference: text().notNull(),
    /** The inference provider slug this price applies on. */
    provider: text().notNull(),

    currency: currencyCode(),

    effectiveFrom: timestamptz().notNull(),
    /** Absent while this version is the current one. */
    effectiveUntil: timestamptz(),

    /**
     * The version this one replaced. A SELF-reference, so it needs the explicit
     * `AnyPgColumn` return type drizzle requires to break the type cycle — and
     * `schema/__tests__/inferenceLedger.test.ts` asserts the constraint actually
     * reached `pg_constraint`, because a column-level circular reference has
     * been silently dropped from both a generated migration and its snapshot
     * before in this repo.
     */
    supersedesPriceVersionId: text().references((): AnyPgColumn => priceVersions.id, {
      onDelete: 'restrict',
    }),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Settlement resolves `(model_reference, provider)` → the version to price
    // with. At most one may be `active`; see the header.
    uniqueIndex('price_versions_active_route_key')
      .on(t.modelReference, t.provider)
      .where(sql`${t.status} = 'active'`),
    // The catalogue's price history for one route, newest first.
    index('price_versions_route_effective_from_idx').on(
      t.modelReference,
      t.provider,
      t.effectiveFrom.desc()
    ),

    check(
      'price_versions_status_check',
      sql`${t.status} in (${sql.raw(inList(PRICE_VERSION_STATUSES))})`
    ),
    check('price_versions_currency_check', currencyCodeCheck(t.currency)),
    check('price_versions_model_reference_check', sql`length(${t.modelReference}) > 0`),
    check('price_versions_provider_check', sql`length(${t.provider}) > 0`),
    // A version must stop applying after it started applying.
    check(
      'price_versions_effective_window_check',
      sql`${t.effectiveUntil} is null or ${t.effectiveUntil} > ${t.effectiveFrom}`
    ),
    // A superseded version priced requests during a window that has CLOSED.
    // Left open it is indistinguishable from the current one when a receipt is
    // re-priced years later, which is the one job this record exists to do.
    check(
      'price_versions_superseded_window_check',
      sql`${t.status} <> 'superseded' or ${t.effectiveUntil} is not null`
    ),
    // A version cannot supersede itself: the chain would be a cycle of one and
    // "what did this replace" would never terminate.
    check(
      'price_versions_supersedes_self_check',
      sql`${t.supersedesPriceVersionId} is null or ${t.supersedesPriceVersionId} <> ${t.id}`
    ),
  ]
);

export const priceVersionUnitPrices = pgTable(
  'price_version_unit_prices',
  {
    priceVersionId: text()
      .notNull()
      .references(() => priceVersions.id, { onDelete: 'cascade' }),
    unit: text({ enum: USAGE_UNITS }).notNull(),
    /** Price for `per` units of `unit`, in the parent version's currency. */
    amount: exactAmount().notNull(),
    /**
     * How many units `amount` buys. Providers quote "$3.00 per 1000000 input
     * tokens" and customers read it that way; a price quoted per single token
     * would need more fractional digits than the scale carries.
     */
    per: bigint({ mode: 'number' }).notNull(),

    createdAt: createdAt(),
  },
  (t) => [
    // A unit may be priced only once per version — the contract's own
    // refinement, made structural by the primary key rather than checked.
    primaryKey({ columns: [t.priceVersionId, t.unit] }),

    check(
      'price_version_unit_prices_unit_check',
      sql`${t.unit} in (${sql.raw(inList(USAGE_UNITS))})`
    ),
    check('price_version_unit_prices_amount_check', sql`${t.amount} >= 0`),
    // `per` divides in every settlement expression, so zero is a division by
    // zero at settle time — a 500 on a request whose money has already been
    // spent upstream.
    check('price_version_unit_prices_per_check', sql`${t.per} > 0`),
  ]
);
