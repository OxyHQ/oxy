/** I07 access provenance. No catalogue rows or financial balances are seeded. */
import { sql } from 'drizzle-orm';
import { bigint, boolean, check, foreignKey, index, integer, pgTable, primaryKey, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, inList, timestamptz, updatedAt } from '@oxy.so/db';
import { applications } from './applications';
import { users } from './users';
import { BILLING_SUBSCRIPTION_STATUSES } from './billingSubscriptions';

export const PRODUCT_OFFER_KINDS = ['individual', 'bundle'] as const;
export const PRODUCT_BENEFIT_KINDS = ['capability', 'quota'] as const;
export const PRODUCT_QUOTA_COMBINATIONS = ['maximum', 'sum', 'exclusive'] as const;
export const PRODUCT_SUBSCRIPTION_PROVIDERS = ['stripe', 'peable'] as const;

/** Registered definition; transferring an application never silently rebinds it. */
export const accessProducts = pgTable('access_products', {
  id: text().primaryKey(),
  ownerAccountId: text().notNull().references(() => users.id, { onDelete: 'restrict' }),
  applicationId: text().notNull().references(() => applications.id, { onDelete: 'restrict' }),
  createdAt: createdAt(),
}, t => [index('access_products_application_idx').on(t.applicationId)]);

export const accessOffers = pgTable('access_offers', {
  id: text().notNull(), version: integer().notNull(),
  kind: text({ enum: PRODUCT_OFFER_KINDS }).notNull(), createdAt: createdAt(),
}, t => [
  primaryKey({ columns: [t.id, t.version] }),
  unique('access_offers_origin_key').on(t.id, t.version, t.kind),
  check('access_offers_version_check', sql`${t.version} > 0`),
  check('access_offers_kind_check', sql`${t.kind} in (${sql.raw(inList(PRODUCT_OFFER_KINDS))})`),
]);

/** One normalized row per explicit benefit; no default quota unit or rule. */
export const accessOfferBenefits = pgTable('access_offer_benefits', {
  offerId: text().notNull(), offerVersion: integer().notNull(), benefitIndex: integer().notNull(),
  productId: text().notNull().references(() => accessProducts.id, { onDelete: 'restrict' }),
  kind: text({ enum: PRODUCT_BENEFIT_KINDS }).notNull(), key: text().notNull(),
  unit: text(), included: bigint({ mode: 'number' }),
  combination: text({ enum: PRODUCT_QUOTA_COMBINATIONS }), createdAt: createdAt(),
}, t => [
  primaryKey({ columns: [t.offerId, t.offerVersion, t.benefitIndex] }),
  unique('access_offer_benefits_product_key').on(t.offerId, t.offerVersion, t.benefitIndex, t.productId),
  foreignKey({ name: 'access_offer_benefits_offer_fk', columns: [t.offerId, t.offerVersion], foreignColumns: [accessOffers.id, accessOffers.version] }).onDelete('restrict'),
  check('access_offer_benefits_index_check', sql`${t.benefitIndex} >= 0`),
  check('access_offer_benefits_kind_check', sql`${t.kind} in (${sql.raw(inList(PRODUCT_BENEFIT_KINDS))})`),
  check('access_offer_benefits_shape_check', sql`(${t.kind} = 'capability' and ${t.unit} is null and ${t.included} is null and ${t.combination} is null) or (${t.kind} = 'quota' and ${t.unit} is not null and length(${t.unit}) > 0 and ${t.included} is not null and ${t.included} between 0 and 9007199254740991 and ${t.combination} is not null and ${t.combination} in (${sql.raw(inList(PRODUCT_QUOTA_COMBINATIONS))}))`),
  check('access_offer_benefits_key_check', sql`length(${t.key}) > 0`),
]);

/** Immutable parties/provider identity, mutable authoritative commercial state. */
export const accessSubscriptionSources = pgTable('access_subscription_sources', {
  id: text().primaryKey(),
  beneficiaryAccountId: text().notNull().references(() => users.id, { onDelete: 'restrict' }),
  payerAccountId: text().notNull().references(() => users.id, { onDelete: 'restrict' }),
  provider: text({ enum: PRODUCT_SUBSCRIPTION_PROVIDERS }).notNull(),
  providerSubscriptionId: text().notNull(),
  providerAccountRef: text().notNull(), mode: text().notNull(), environment: text().notNull(),
  status: text({ enum: BILLING_SUBSCRIPTION_STATUSES }).notNull(),
  periodStart: timestamptz().notNull(), periodEnd: timestamptz().notNull(),
  cancelAtPeriodEnd: boolean().notNull(), providerObservedAt: timestamptz().notNull(),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, t => [
  unique('access_subscription_sources_provider_key').on(t.provider, t.providerAccountRef, t.mode, t.environment, t.providerSubscriptionId),
  unique('access_subscription_sources_beneficiary_key').on(t.id, t.beneficiaryAccountId),
  index('access_subscription_sources_beneficiary_idx').on(t.beneficiaryAccountId, t.status),
  check('access_subscription_sources_live_check', sql`${t.mode} = 'live' and ${t.environment} = 'production' and length(${t.providerAccountRef}) > 0`),
  check('access_subscription_sources_provider_check', sql`${t.provider} in (${sql.raw(inList(PRODUCT_SUBSCRIPTION_PROVIDERS))})`),
  check('access_subscription_sources_status_check', sql`${t.status} in (${sql.raw(inList(BILLING_SUBSCRIPTION_STATUSES))})`),
  check('access_subscription_sources_period_check', sql`${t.periodEnd} > ${t.periodStart}`),
]);

/** Frozen offer and period. Upgrades/renewals append another segment. */
export const accessOfferSegments = pgTable('access_offer_segments', {
  id: text().primaryKey(), subscriptionId: text().notNull(), beneficiaryAccountId: text().notNull(),
  offerId: text().notNull(), offerVersion: integer().notNull(),
  origin: text({ enum: PRODUCT_OFFER_KINDS }).notNull(),
  periodStart: timestamptz().notNull(), periodEnd: timestamptz().notNull(), createdAt: createdAt(),
}, t => [
  unique('access_offer_segments_provenance_key').on(t.id, t.beneficiaryAccountId, t.offerId, t.offerVersion, t.origin),
  foreignKey({ name: 'access_offer_segments_subject_fk', columns: [t.subscriptionId, t.beneficiaryAccountId], foreignColumns: [accessSubscriptionSources.id, accessSubscriptionSources.beneficiaryAccountId] }).onDelete('restrict'),
  foreignKey({ name: 'access_offer_segments_offer_fk', columns: [t.offerId, t.offerVersion, t.origin], foreignColumns: [accessOffers.id, accessOffers.version, accessOffers.kind] }).onDelete('restrict'),
  index('access_offer_segments_source_idx').on(t.subscriptionId),
  check('access_offer_segments_period_check', sql`${t.periodEnd} > ${t.periodStart}`),
]);

/** Benefit/subject/source are immutable. Revocation is one-way, never deletion. */
export const accessGrants = pgTable('access_grants', {
  id: text().primaryKey(), sourceSegmentId: text().notNull(), beneficiaryAccountId: text().notNull(),
  offerId: text().notNull(), offerVersion: integer().notNull(),
  origin: text({ enum: PRODUCT_OFFER_KINDS }).notNull(),
  benefitIndex: integer().notNull(), productId: text().notNull(),
  periodStart: timestamptz().notNull(), periodEnd: timestamptz().notNull(), revokedAt: timestamptz(),
  createdAt: createdAt(),
}, t => [
  unique('access_grants_segment_benefit_key').on(t.sourceSegmentId, t.benefitIndex),
  foreignKey({ name: 'access_grants_source_fk', columns: [t.sourceSegmentId, t.beneficiaryAccountId, t.offerId, t.offerVersion, t.origin], foreignColumns: [accessOfferSegments.id, accessOfferSegments.beneficiaryAccountId, accessOfferSegments.offerId, accessOfferSegments.offerVersion, accessOfferSegments.origin] }).onDelete('restrict'),
  foreignKey({ name: 'access_grants_benefit_fk', columns: [t.offerId, t.offerVersion, t.benefitIndex, t.productId], foreignColumns: [accessOfferBenefits.offerId, accessOfferBenefits.offerVersion, accessOfferBenefits.benefitIndex, accessOfferBenefits.productId] }).onDelete('restrict'),
  index('access_grants_subject_product_idx').on(t.beneficiaryAccountId, t.productId, t.periodEnd),
  check('access_grants_period_check', sql`${t.periodEnd} > ${t.periodStart}`),
]);
