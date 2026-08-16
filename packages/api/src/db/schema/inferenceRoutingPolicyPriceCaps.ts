/**
 * `inference_routing_policy_price_caps` — the maximum a customer will pay per
 * metered unit, for one immutable policy version.
 *
 * The epic's "maximum customer price per unit/request" control has two halves.
 * The per-REQUEST half is a single amount and lives on the version row; the
 * per-UNIT half is one amount per unit and lives here, because eleven nullable
 * amount columns on the version would be eleven places a currency could
 * disagree with itself.
 *
 * ## Two contradictions this table cannot express
 *
 * **Two ceilings for one unit.** The primary key is `(version_id, unit)`. The
 * contract has to check this with a refinement because a wire array can hold the
 * same unit twice; a row cannot.
 *
 * **Ceilings in mixed currencies.** There is no currency of the cap's own — the
 * `currency` column here exists ONLY as half of the composite foreign key into
 * `inference_routing_policy_versions (id, price_ceiling_currency)`, so it is
 * constrained to equal the version's currency and cannot drift from it. The same
 * key also refuses a cap on a version that declares no currency at all: NULL
 * never matches a foreign key, so a version with `price_ceiling_currency IS NULL`
 * is not a valid parent for any cap.
 *
 * That is the whole reason the column is duplicated. A denormalised copy is
 * normally a place for two values to disagree; a copy that is the child half of
 * a composite foreign key is the opposite — it is how a relational schema states
 * "these must be equal" without a trigger.
 *
 * ## Append-only, with its parent
 *
 * A version nobody may edit whose price ceilings anybody may rewrite is not
 * immutable, so the same `BEFORE UPDATE` guard covers this table — the exact
 * reasoning `usage_receipt_unit_prices` records for the settled price snapshot.
 * `CASCADE` on the composite key: a cap belongs to its version and to nothing
 * else.
 */

import { sql } from 'drizzle-orm';
import { bigint, check, foreignKey, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { createdAt, inList } from '@oxyhq/db';
import { USAGE_UNITS } from '@oxyhq/contracts';
import { currencyCodeCheck, exactAmount } from './ledgerColumns';
import { inferenceRoutingPolicyVersions } from './inferenceRoutingPolicyVersions';

export const inferenceRoutingPolicyPriceCaps = pgTable(
  'inference_routing_policy_price_caps',
  {
    versionId: text().notNull(),

    unit: text({ enum: USAGE_UNITS }).notNull(),

    /**
     * Not the cap's own currency — the version's, carried here so the composite
     * foreign key below can force the two to be the same value. Never written
     * from a request body; the service copies it off the version it is writing.
     */
    currency: text().notNull(),

    /** The ceiling, as `amount` per `per` units — quoted like catalogue prices. */
    amount: exactAmount().notNull(),
    per: bigint({ mode: 'number' }).notNull(),

    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.versionId, t.unit] }),

    foreignKey({
      name: 'inference_routing_policy_price_caps_version_fk',
      columns: [t.versionId, t.currency],
      foreignColumns: [
        inferenceRoutingPolicyVersions.id,
        inferenceRoutingPolicyVersions.priceCeilingCurrency,
      ],
    }).onDelete('cascade'),

    check(
      'inference_routing_policy_price_caps_unit_check',
      sql`${t.unit} in (${sql.raw(inList(USAGE_UNITS))})`
    ),
    check('inference_routing_policy_price_caps_currency_format', currencyCodeCheck(t.currency)),
    check('inference_routing_policy_price_caps_amount_check', sql`${t.amount} >= 0`),
    check('inference_routing_policy_price_caps_per_check', sql`${t.per} > 0`),
  ]
);

export type InferenceRoutingPolicyPriceCapRow =
  typeof inferenceRoutingPolicyPriceCaps.$inferSelect;
