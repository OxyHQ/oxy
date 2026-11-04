import { sql } from 'drizzle-orm';
import {
  pgTable,
  text,
  integer,
  bigint,
  uniqueIndex,
  check,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { createdAt, timestamptz } from '@oxy.so/db';
import { users } from './users';
import { accessOffers, accessSubscriptionSources } from './productAccess';
/** Durable checkout reservation, never an entitlement or financial award.
 * The approved price is frozen into typed columns at reservation, so a replay
 * keeps the original price after the catalogue changes. */
export const personalPlanCheckoutIntents = pgTable(
  'personal_plan_checkout_intents',
  {
    id: text().primaryKey(),
    subjectAccountId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    mode: text().notNull(),
    environment: text().notNull(),
    idempotencyHash: text().notNull(),
    requestHash: text().notNull(),
    offerId: text().notNull(),
    offerVersion: integer().notNull(),
    offerKind: text({ enum: ['bundle', 'individual'] }).notNull(),
    providerAccountRef: text().notNull(),
    priceId: text().notNull(),
    priceProvider: text({ enum: ['stripe', 'peable'] }).notNull(),
    priceKind: text({ enum: ['oxy_one', 'existing_product'] }).notNull(),
    currency: text().notNull(),
    amountMinorUnits: bigint({ mode: 'number' }).notNull(),
    billingInterval: text({ enum: ['month', 'year'] })
      .notNull()
      .default('month'),
    priceValidFrom: timestamptz().notNull(),
    priceValidUntil: timestamptz(),
    state: text({ enum: ['reserved', 'pending', 'fulfilled', 'closed'] }).notNull(),
    closedReason: text(),
    providerSessionId: text(),
    checkoutUrl: text(),
    providerSessionExpiresAt: timestamptz(),
    applicationRef: text(),
    customerRef: text(),
    returnUrl: text(),
    initialInvoiceId: text(),
    fulfilledSourceId: text().references(() => accessSubscriptionSources.id, {
      onDelete: 'restrict',
    }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('personal_checkout_request_key').on(
      t.subjectAccountId,
      t.mode,
      t.environment,
      t.idempotencyHash,
    ),
    uniqueIndex('personal_checkout_pending_subject')
      .on(t.subjectAccountId, t.mode, t.environment)
      .where(sql`${t.state} in ('reserved', 'pending')`),
    // Versioned and kind-bound: a checkout can only reserve a registered bundle offer version.
    foreignKey({
      name: 'personal_checkout_offer_fk',
      columns: [t.offerId, t.offerVersion, t.offerKind],
      foreignColumns: [accessOffers.id, accessOffers.version, accessOffers.kind],
    }).onDelete('restrict'),
    check(
      'personal_checkout_interval',
      sql`${t.billingInterval} IN ('month', 'year') AND (${t.priceKind} <> 'oxy_one' OR ${t.billingInterval} = 'month')`,
    ),
    check(
      'personal_checkout_namespace',
      sql`(${t.mode} = 'live' and ${t.environment} = 'production') or (${t.mode} = 'test' and ${t.environment} in ('test', 'staging', 'development'))`,
    ),
    check(
      'personal_checkout_state',
      sql`${t.state} in ('reserved', 'pending', 'fulfilled', 'closed')`,
    ),
    check(
      'personal_checkout_price',
      sql`((${t.offerKind} = 'bundle' and ${t.priceKind} = 'oxy_one') or (${t.offerKind} = 'individual' and ${t.priceKind} = 'existing_product')) and ${t.priceProvider} in ('stripe', 'peable') and ${t.currency} ~ '^[a-z]{3}$' and ${t.amountMinorUnits} > 0 and (${t.priceValidUntil} is null or ${t.priceValidUntil} > ${t.priceValidFrom})`,
    ),
    // The provider binding is frozen whole or not at all.
    check(
      'personal_checkout_binding_complete',
      sql`(${t.applicationRef} is null and ${t.customerRef} is null and ${t.returnUrl} is null) or (${t.applicationRef} is not null and ${t.customerRef} is not null and ${t.returnUrl} is not null)`,
    ),
    check(
      'personal_checkout_session_expiry',
      sql`${t.providerSessionExpiresAt} is null or ${t.providerSessionId} is not null`,
    ),
    check(
      'personal_checkout_fulfillment',
      sql`(${t.state} = 'fulfilled') = (${t.fulfilledSourceId} is not null)`,
    ),
  ],
);
