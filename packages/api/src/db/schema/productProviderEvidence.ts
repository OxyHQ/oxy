/** Normalized trusted evidence only; not a financial ledger or remote verification. */
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  jsonb,
  pgTable,
  primaryKey,
  text,
  integer,
  unique,
} from 'drizzle-orm/pg-core';
import { createdAt, inList, timestamptz } from '@oxy.so/db';
import {
  accessSubscriptionSources,
  accessOfferSegments,
  PRODUCT_SUBSCRIPTION_PROVIDERS,
  PRODUCT_OFFER_KINDS,
} from './productAccess';

/** One paid line, independent of caller IDs, configuration or event delivery IDs. */
export const accessProviderPeriods = pgTable(
  'access_provider_periods',
  {
    id: text().primaryKey(),
    provider: text({ enum: PRODUCT_SUBSCRIPTION_PROVIDERS }).notNull(),
    providerAccountRef: text().notNull(),
    mode: text().notNull(),
    environment: text().notNull(),
    invoiceId: text().notNull(),
    lineId: text().notNull(),
    priceId: text().notNull(),
    sourceId: text().notNull(),
    providerSubscriptionId: text().notNull(),
    beneficiaryAccountId: text().notNull(),
    payerAccountId: text().notNull(),
    segmentId: text().notNull(),
    offerId: text().notNull(),
    offerVersion: integer().notNull(),
    origin: text({ enum: PRODUCT_OFFER_KINDS }).notNull(),
    periodStart: timestamptz().notNull(),
    periodEnd: timestamptz().notNull(),
    payload: jsonb().notNull(),
    payloadSha256: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('access_provider_periods_financial_key').on(
      t.provider,
      t.providerAccountRef,
      t.mode,
      t.environment,
      t.invoiceId,
      t.lineId,
    ),
    unique('access_provider_periods_event_binding_key').on(
      t.id,
      t.sourceId,
      t.provider,
      t.providerAccountRef,
      t.mode,
      t.environment,
    ),
    foreignKey({
      name: 'access_provider_periods_source_fk',
      columns: [
        t.sourceId,
        t.beneficiaryAccountId,
        t.payerAccountId,
        t.provider,
        t.providerAccountRef,
        t.mode,
        t.environment,
        t.providerSubscriptionId,
      ],
      foreignColumns: [
        accessSubscriptionSources.id,
        accessSubscriptionSources.beneficiaryAccountId,
        accessSubscriptionSources.payerAccountId,
        accessSubscriptionSources.provider,
        accessSubscriptionSources.providerAccountRef,
        accessSubscriptionSources.mode,
        accessSubscriptionSources.environment,
        accessSubscriptionSources.providerSubscriptionId,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'access_provider_periods_segment_fk',
      columns: [
        t.segmentId,
        t.sourceId,
        t.beneficiaryAccountId,
        t.offerId,
        t.offerVersion,
        t.origin,
        t.periodStart,
        t.periodEnd,
      ],
      foreignColumns: [
        accessOfferSegments.id,
        accessOfferSegments.subscriptionId,
        accessOfferSegments.beneficiaryAccountId,
        accessOfferSegments.offerId,
        accessOfferSegments.offerVersion,
        accessOfferSegments.origin,
        accessOfferSegments.periodStart,
        accessOfferSegments.periodEnd,
      ],
    }).onDelete('restrict'),
    check(
      'access_provider_periods_binding_check',
      sql`((${t.mode} = 'live' and ${t.environment} = 'production') or (${t.mode} = 'test' and ${t.environment} in ('test', 'staging', 'development'))) and length(${t.providerAccountRef}) between 1 and 160`,
    ),
    check(
      'access_provider_periods_provider_check',
      sql`${t.provider} in (${sql.raw(inList(PRODUCT_SUBSCRIPTION_PROVIDERS))})`,
    ),
    check(
      'access_provider_periods_identity_check',
      sql`length(${t.invoiceId}) between 1 and 160 and length(${t.lineId}) between 1 and 160 and length(${t.priceId}) between 1 and 160`,
    ),
    check(
      'access_provider_periods_payload_check',
      sql`jsonb_typeof(${t.payload}) = 'object' and ${t.payloadSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check('access_provider_periods_period_check', sql`${t.periodEnd} > ${t.periodStart}`),
  ],
);

/** Delivery deduplication maps to the same frozen line/source, never new grants. */
export const accessProviderEvents = pgTable(
  'access_provider_events',
  {
    provider: text({ enum: PRODUCT_SUBSCRIPTION_PROVIDERS }).notNull(),
    providerAccountRef: text().notNull(),
    mode: text().notNull(),
    environment: text().notNull(),
    eventId: text().notNull(),
    evidenceId: text().notNull(),
    sourceId: text().notNull(),
    payload: jsonb().notNull(),
    payloadSha256: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({
      name: 'access_provider_events_delivery_pk',
      columns: [t.provider, t.providerAccountRef, t.mode, t.environment, t.eventId],
    }),
    foreignKey({
      name: 'access_provider_events_period_fk',
      columns: [t.evidenceId, t.sourceId, t.provider, t.providerAccountRef, t.mode, t.environment],
      foreignColumns: [
        accessProviderPeriods.id,
        accessProviderPeriods.sourceId,
        accessProviderPeriods.provider,
        accessProviderPeriods.providerAccountRef,
        accessProviderPeriods.mode,
        accessProviderPeriods.environment,
      ],
    }).onDelete('restrict'),
    check('access_provider_events_identity_check', sql`length(${t.eventId}) between 1 and 160`),
    check(
      'access_provider_events_payload_check',
      sql`jsonb_typeof(${t.payload}) = 'object' and ${t.payloadSha256} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);
