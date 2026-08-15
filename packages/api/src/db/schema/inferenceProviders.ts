/**
 * `inference_providers` — who RUNS the weights.
 *
 * The fourth of ADR 0008's six concepts. A provider is not a publisher: Bedrock
 * serves Llama and publishes nothing, Meta publishes Llama and serves nothing.
 * The same revision served by two providers is two DEPLOYMENTS, one model, one
 * revision — which is only expressible because these are separate objects.
 *
 * Keyed on its slug for the same reason `inference_publishers` is: the slug is
 * a public, customer-visible identifier (it appears in the serving-provider
 * attribution on a response, and in the ledger's `price_versions.provider`),
 * so it is immutable by contract. See that table's header for the full argument
 * and for why this is a deliberate exception to the `generatedId()` rule.
 *
 * ## The data policy lives here AND on the deployment
 *
 * That is not duplication. This is the provider's own published policy — what
 * the organization says it does with payloads in general. The deployment's copy
 * is what THIS ROUTE does, which can be stricter (a zero-retention endpoint from
 * a provider whose default retains) and is what a routing policy is enforced
 * against. A single copy would force one of two wrong answers: either every
 * route inherits the provider's laxest policy, or a stricter endpoint cannot be
 * represented at all.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, inList, updatedAt } from '@oxyhq/db';
import { SLUG_CHECK_PATTERN } from './inferenceSlug';

/**
 * What kind of organization serves the route. Mirrors
 * `inferenceProviderSchema.kind`.
 *
 * `customer_byok` means the customer's own upstream account is billed directly
 * by the provider and Oxy charges only its platform fee — which is why a
 * BYOK route carries no customer model price (see `inference_deployments`).
 */
export const INFERENCE_PROVIDER_KINDS = ['third_party', 'oxy_hosted', 'customer_byok'] as const;

export type InferenceProviderKind = (typeof INFERENCE_PROVIDER_KINDS)[number];

export const inferenceProviders = pgTable(
  'inference_providers',
  {
    /** e.g. `openai`, `bedrock`, `oxy-hosted`. Lowercase, URL-safe, immutable. */
    slug: text().primaryKey(),

    displayName: text().notNull(),
    kind: text({ enum: INFERENCE_PROVIDER_KINDS }).notNull(),

    websiteUrl: text(),
    statusPageUrl: text(),

    /**
     * Regions the provider operates in. Absent is NULL, never `'{}'`: "we have
     * not recorded the regions" and "this provider operates in no regions" are
     * different facts, and a residency policy evaluated against the second when
     * the first is true would refuse every route.
     */
    regions: text().array(),

    /* ---- the provider's published data policy (`inferenceDataPolicySchema`) */

    retainsPayloads: boolean().notNull(),
    /** Zero when nothing is retained. Bounded at ten years, as the contract is. */
    retentionDays: integer().notNull(),
    trainsOnCustomerData: boolean().notNull(),
    zeroDataRetentionAvailable: boolean().notNull(),
    /** Named subprocessors a payload may pass through, for compliance review. */
    subprocessors: text().array(),
    policyUrl: text(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('inference_providers_slug_format', sql`${t.slug} ~ ${sql.raw(SLUG_CHECK_PATTERN)}`),
    check(
      'inference_providers_kind_check',
      sql`${t.kind} in (${sql.raw(inList(INFERENCE_PROVIDER_KINDS))})`
    ),

    /**
     * The two coherence rules `inferenceDataPolicySchema` refines, in the
     * database so a seed script or a backfill cannot bypass them.
     *
     * Both matter because a ROUTING POLICY is enforced against these fields: a
     * route claiming `retains_payloads = false` alongside a retention window, or
     * alongside training on customer data, is reporting one of the two wrongly —
     * and a customer's "never train on my data" constraint would then be
     * evaluated against a value that is not true.
     */
    check(
      'inference_providers_retention_coherent',
      sql`${t.retentionDays} >= 0 and ${t.retentionDays} <= 3650 and (${t.retainsPayloads} or ${t.retentionDays} = 0)`
    ),
    check(
      'inference_providers_training_requires_retention',
      sql`${t.retainsPayloads} or not ${t.trainsOnCustomerData}`
    ),
  ]
);

export type InferenceProviderRow = typeof inferenceProviders.$inferSelect;
