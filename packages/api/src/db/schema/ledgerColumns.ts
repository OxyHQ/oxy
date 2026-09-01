/**
 * Ledger Column Builders — money and metered units, declared once.
 *
 * Schema SUPPORT, not a table: this module is imported directly by the ledger
 * and telemetry tables, never re-exported from `schema/index.ts` (see that
 * file's header).
 *
 * Two decisions live here, and both are the structural half of ADR 0009
 * (`docs/adr/0009-usage-reservation-and-settlement.md`):
 *
 *  1. **Customer money is exact `NUMERIC`, never `double precision`, never
 *     `real`, and never an integer count of minor units.** The scale is the
 *     one the wire contract declares (`INFERENCE_MONEY_SCALE` in
 *     `@oxyhq/contracts`), so a value cannot lose precision crossing the
 *     boundary in either direction. `mode: 'string'` is explicit rather than
 *     inherited from drizzle's default: `postgres.js` hands `numeric` back as a
 *     string, and stating it here means a future default change cannot silently
 *     start parsing money into a JS `number`.
 *
 *  2. **Units are integers in their own columns, and are never money.** A
 *     receipt says both "204 output tokens" and "0.003060000000 USD", and
 *     neither is derived from the other at read time — which is what lets a
 *     price version change without rewriting settled history.
 *
 * ## Why fixed unit COLUMNS rather than a child table or `jsonb`
 *
 * `USAGE_UNITS` is a closed vocabulary of eleven values that changes only by
 * contract change. Fixed columns make three things true that a child table does
 * not:
 *
 *  - the contract's "each unit is reported once, as a total" refinement is
 *    unrepresentable-otherwise rather than enforced by a unique index;
 *  - every aggregate ("by account, application, credential, model, provider,
 *    status and day") is a plain `sum()` with no join, on what will be the
 *    highest-volume table in the schema;
 *  - the daily rollup can be maintained by one `ON CONFLICT … DO UPDATE`
 *    adding each column to itself, which a child table cannot express.
 *
 * The cost is that adding a unit needs a migration. That is the correct cost:
 * the unit set is a published contract, not configuration.
 *
 * The one semantic the column form cannot carry is the contract's
 * `units.min(1)` — with eleven columns every unit is always present, so "at
 * least one unit is named" is vacuous here. A receipt that settles zero units
 * is legitimate (an upstream failure that produced nothing, per ADR 0009), and
 * what actually needs guarding is the other direction: an amount billed against
 * no units at all. `usage_receipts` carries that CHECK.
 *
 * ## `bigint`, not `integer`
 *
 * A per-request token count fits in `integer`, but the daily rollups sum the
 * same columns across an account's whole traffic and 2.1 billion tokens in a
 * day is reachable. One builder for both places is only correct at `bigint`, and
 * two builders that differ only in width is exactly the kind of divergence that
 * shows up as an overflow years later. `mode: 'number'` matches the contract's
 * `z.number().int().nonnegative().safe()` — every quantity is inside
 * `Number.MAX_SAFE_INTEGER` by contract.
 *
 * **Read the driver's decoding before doing arithmetic on these.** `mode:
 * 'number'` is applied by drizzle's RESULT MAPPER, so it does not apply to a raw
 * `db.execute` — the same column comes back as a `number` from the query builder
 * and as a `string` from raw SQL, typed `number` either way.
 */

import { sql, type SQL } from 'drizzle-orm';
import { bigint, check, numeric, text, type PgColumn } from 'drizzle-orm/pg-core';
import { INFERENCE_MONEY_SCALE, type UsageUnit } from '@oxyhq/contracts';

/**
 * Integer digits an amount may carry, on top of {@link INFERENCE_MONEY_SCALE}
 * fractional digits. Eighteen is what `exactDecimalSchema` admits, so the column
 * accepts exactly what the wire does — no value can be valid on one side and
 * rejected on the other.
 */
export const EXACT_AMOUNT_INTEGER_DIGITS = 18;

/** `numeric(30, 12)` — total precision, as Postgres counts it. */
export const EXACT_AMOUNT_PRECISION = EXACT_AMOUNT_INTEGER_DIGITS + INFERENCE_MONEY_SCALE;

/**
 * The currency every ledger row is denominated in when nothing says otherwise.
 *
 * Deliberately the same literal `billing_subscriptions` already uses, so an
 * account cannot end up with a Stripe subscription in one currency and an
 * inference balance in another purely by default.
 */
export const DEFAULT_LEDGER_CURRENCY = 'USD';

/**
 * An exact, non-negative amount of customer money.
 *
 * Non-negative is not enforced here — a builder cannot carry a CHECK — so every
 * table using this declares its own `>= 0` constraint. That is deliberate rather
 * than an oversight: the constraint has to name its column in the error message
 * for the failure to be readable, and a shared one would name none of them.
 *
 * Direction is carried by the SHAPE, never by a sign: a settlement debits, a
 * refund credits, and each is a different record. A signed amount is how a
 * reversal silently becomes a second charge.
 */
export const exactAmount = () =>
  numeric({ precision: EXACT_AMOUNT_PRECISION, scale: INFERENCE_MONEY_SCALE, mode: 'string' });

/** ISO 4217 alpha-3, e.g. `USD`. Validated by CHECK at each table. */
export const currencyCode = () => text().notNull().default(DEFAULT_LEDGER_CURRENCY);

/** A three-letter uppercase currency code, as a CHECK expression. */
export function currencyCodeCheck(column: PgColumn): SQL {
  return sql`${column} ~ '^[A-Z]{3}$'`;
}

/**
 * One metered quantity column per {@link USAGE_UNITS} value.
 *
 * Spread into a `pgTable` definition:
 *
 * ```ts
 * pgTable('usage_receipts', { id: generatedId(), ...usageUnitColumns() })
 * ```
 *
 * The TypeScript property names are the camelCase of the unit slugs, so
 * drizzle's casing renders exactly the unit name in SQL — `audio_input_milliseconds`
 * is both the contract's unit and the column. {@link USAGE_UNIT_COLUMN_KEYS} is
 * the map between them, and `__tests__/inferenceLedger.test.ts` fails if a unit
 * ever exists without a column or the reverse.
 */
export const usageUnitColumns = () => ({
  inputTokens: bigint({ mode: 'number' }).notNull().default(0),
  cachedInputTokens: bigint({ mode: 'number' }).notNull().default(0),
  outputTokens: bigint({ mode: 'number' }).notNull().default(0),
  reasoningTokens: bigint({ mode: 'number' }).notNull().default(0),
  requests: bigint({ mode: 'number' }).notNull().default(0),
  images: bigint({ mode: 'number' }).notNull().default(0),
  audioInputMilliseconds: bigint({ mode: 'number' }).notNull().default(0),
  audioOutputMilliseconds: bigint({ mode: 'number' }).notNull().default(0),
  videoMilliseconds: bigint({ mode: 'number' }).notNull().default(0),
  characters: bigint({ mode: 'number' }).notNull().default(0),
  embeddings: bigint({ mode: 'number' }).notNull().default(0),
});

/** The property name each contract unit is stored under. */
export type UsageUnitColumnKey = keyof ReturnType<typeof usageUnitColumns>;

/**
 * Contract unit → column property, in one place.
 *
 * A hand-maintained map, so it gets a completeness gate rather than trust:
 * `__tests__/inferenceLedger.test.ts` asserts this map's key set EQUALS `USAGE_UNITS` in
 * both directions, and that every value names a real column on a table built
 * from {@link usageUnitColumns}. A map that merely SKIPS what it does not know
 * about would be no gate at all.
 */
export const USAGE_UNIT_COLUMN_KEYS: Readonly<Record<UsageUnit, UsageUnitColumnKey>> = {
  input_tokens: 'inputTokens',
  cached_input_tokens: 'cachedInputTokens',
  output_tokens: 'outputTokens',
  reasoning_tokens: 'reasoningTokens',
  requests: 'requests',
  images: 'images',
  audio_input_milliseconds: 'audioInputMilliseconds',
  audio_output_milliseconds: 'audioOutputMilliseconds',
  video_milliseconds: 'videoMilliseconds',
  characters: 'characters',
  embeddings: 'embeddings',
};

/**
 * A contract-shaped `{ unit: quantity }` report as the columns a row carries.
 *
 * Unreported units are ZERO rather than absent: every column is `NOT NULL`, and
 * "the provider did not mention output tokens" and "the provider reported zero
 * output tokens" are the same fact for a charge — the distinction that DOES
 * matter is carried by `usage_source`, which says whether the whole report was
 * measured, reported or reconstructed.
 */
export function usageUnitColumnValues(
  units: Partial<Record<UsageUnit, number>>
): Record<UsageUnitColumnKey, number> {
  const row = zeroUsageUnits();
  for (const [unit, key] of Object.entries(USAGE_UNIT_COLUMN_KEYS) as [
    UsageUnit,
    UsageUnitColumnKey,
  ][]) {
    const quantity = units[unit];
    if (quantity !== undefined) {
      row[key] = quantity;
    }
  }
  return row;
}

/** A zeroed quantity for every unit — the starting point for a partial report. */
export function zeroUsageUnits(): Record<UsageUnitColumnKey, number> {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    requests: 0,
    images: 0,
    audioInputMilliseconds: 0,
    audioOutputMilliseconds: 0,
    videoMilliseconds: 0,
    characters: 0,
    embeddings: 0,
  };
}

/**
 * `every unit column >= 0`, as one CHECK.
 *
 * Built by walking {@link USAGE_UNIT_COLUMN_KEYS} rather than by listing the
 * columns again, so a unit added to the map is constrained without a second
 * edit — the failure mode of a hand-written list here is a unit that silently
 * admits a negative quantity into a `sum()` a customer is shown.
 */
export function usageUnitsNonNegativeCheck(
  name: string,
  columns: Record<UsageUnitColumnKey, PgColumn>
): ReturnType<typeof check> {
  const clauses = Object.values(USAGE_UNIT_COLUMN_KEYS).map((key) => sql`${columns[key]} >= 0`);
  return check(name, sql.join(clauses, sql` and `));
}

/** `input_tokens + … + embeddings`, for "was anything at all metered?". */
export function totalUsageUnitsExpression(
  columns: Record<UsageUnitColumnKey, PgColumn>
): SQL {
  const terms = Object.values(USAGE_UNIT_COLUMN_KEYS).map((key) => sql`${columns[key]}`);
  return sql.join(terms, sql` + `);
}
