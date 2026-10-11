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
    offerKind: text({ enum: ['bundle'] }).notNull(),
    providerAccountRef: text().notNull(),
    priceId: text().notNull(),
    priceProvider: text({ enum: ['stripe', 'peable'] }).notNull(),
    priceKind: text({ enum: ['oxy_one'] }).notNull(),
    currency: text().notNull(),
    amountMinorUnits: bigint({ mode: 'number' }).notNull(),
    priceValidFrom: timestamptz().notNull(),
    priceValidUntil: timestamptz(),
    state: text({ enum: ['reserved', 'pending', 'fulfilled', 'closed'] }).notNull(),
    closedReason: text(),
    providerSessionId: text(),
    checkoutUrl: text(),
    providerSessionExpiresAt: timestamptz(),
    applicationRef: text(),
    planRef: text(),
    customerRef: text(),
    taxQuoteRef: text(),
    taxQuoteCurrency: text(),
    taxQuoteNetMinorUnits: bigint({ mode: 'number' }),
    taxQuoteTaxMinorUnits: bigint({ mode: 'number' }),
    taxQuoteSellerRef: text(),
    taxQuoteInvoiceIssuerRef: text(),
    taxQuoteTaxRemitterRef: text(),
    taxQuoteTaxServiceRef: text(),
    taxQuoteCountry: text(),
    taxQuoteCoverageEvidenceRef: text(),
    taxQuoteTaxRateEvidenceRef: text(),
    taxQuoteCustomerLocationEvidenceRef: text(),
    taxQuoteQuotedAt: timestamptz(),
    taxQuoteExpiresAt: timestamptz(),
    taxQuoteQuotedAtLexeme: text(),
    taxQuoteExpiresAtLexeme: text(),
    taxQuoteSignatureKeyRef: text(),
    taxQuoteSignatureValue: text(),
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
      'personal_checkout_namespace',
      sql`(${t.mode} = 'live' and ${t.environment} = 'production') or (${t.mode} = 'test' and ${t.environment} in ('test', 'staging', 'development'))`,
    ),
    check(
      'personal_checkout_state',
      sql`${t.state} in ('reserved', 'pending', 'fulfilled', 'closed')`,
    ),
    check(
      'personal_checkout_price',
      sql`${t.offerKind} = 'bundle' and ${t.priceKind} = 'oxy_one' and ${t.priceProvider} in ('stripe', 'peable') and ${t.currency} ~ '^[a-z]{3}$' and ${t.amountMinorUnits} > 0 and (${t.priceValidUntil} is null or ${t.priceValidUntil} > ${t.priceValidFrom})`,
    ),
    check(
      'personal_checkout_authority_complete',
      sql`(${t.applicationRef} is null and ${t.planRef} is null and ${t.customerRef} is null and ${t.taxQuoteRef} is null and ${t.taxQuoteCurrency} is null and ${t.taxQuoteNetMinorUnits} is null and ${t.taxQuoteTaxMinorUnits} is null and ${t.taxQuoteSellerRef} is null and ${t.taxQuoteInvoiceIssuerRef} is null and ${t.taxQuoteTaxRemitterRef} is null and ${t.taxQuoteTaxServiceRef} is null and ${t.taxQuoteCountry} is null and ${t.taxQuoteCoverageEvidenceRef} is null and ${t.taxQuoteTaxRateEvidenceRef} is null and ${t.taxQuoteCustomerLocationEvidenceRef} is null and ${t.taxQuoteQuotedAt} is null and ${t.taxQuoteExpiresAt} is null and ${t.taxQuoteQuotedAtLexeme} is null and ${t.taxQuoteExpiresAtLexeme} is null and ${t.taxQuoteSignatureKeyRef} is null and ${t.taxQuoteSignatureValue} is null and ${t.returnUrl} is null) or (${t.applicationRef} is not null and ${t.planRef} is not null and ${t.customerRef} is not null and ${t.taxQuoteRef} is not null and ${t.taxQuoteCurrency} is not null and ${t.taxQuoteNetMinorUnits} is not null and ${t.taxQuoteTaxMinorUnits} is not null and ${t.taxQuoteSellerRef} is not null and ${t.taxQuoteInvoiceIssuerRef} is not null and ${t.taxQuoteTaxRemitterRef} is not null and ${t.taxQuoteTaxServiceRef} is not null and ${t.taxQuoteCountry} is not null and ${t.taxQuoteCoverageEvidenceRef} is not null and ${t.taxQuoteTaxRateEvidenceRef} is not null and ${t.taxQuoteCustomerLocationEvidenceRef} is not null and ${t.taxQuoteQuotedAt} is not null and ${t.taxQuoteExpiresAt} is not null and ${t.taxQuoteQuotedAtLexeme} is not null and ${t.taxQuoteExpiresAtLexeme} is not null and ${t.taxQuoteSignatureKeyRef} is not null and ${t.taxQuoteSignatureValue} is not null and ${t.returnUrl} is not null)`,
    ),
    check(
      'personal_checkout_quote_amounts',
      sql`${t.taxQuoteRef} is null or (${t.taxQuoteNetMinorUnits} >= 0 and ${t.taxQuoteTaxMinorUnits} >= 0 and ${t.taxQuoteNetMinorUnits} + ${t.taxQuoteTaxMinorUnits} = ${t.amountMinorUnits})`,
    ),
    check(
      'personal_checkout_quote_timestamps',
      sql`${t.taxQuoteRef} is null or (${t.taxQuoteExpiresAt} > ${t.taxQuoteQuotedAt} and ${t.taxQuoteQuotedAtLexeme}::timestamptz = ${t.taxQuoteQuotedAt} and ${t.taxQuoteExpiresAtLexeme}::timestamptz = ${t.taxQuoteExpiresAt})`,
    ),
    check(
      'personal_checkout_quote_country',
      sql`${t.taxQuoteCountry} is null or ${t.taxQuoteCountry} ~ '^[A-Z]{2}$'`,
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
