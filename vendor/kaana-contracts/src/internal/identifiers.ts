/**
 * Identifiers only Oxy and Kaana exchange: the billing account, the opaque
 * deployment and provider identities, and the funding tier.
 *
 * Moved from `@oxy.so/contracts` 4.12.0 (`src/inference/identifiers.ts`) by Kaana ADR 0002.
 */

import { z } from 'zod';

/**
 * An Oxy account id — the account that owns the workload and is financially
 * responsible for it.
 *
 * Branded, and that brand is load-bearing rather than decorative: it is the
 * type-level half of the rule that a delegated end-user identity can never
 * become the billing identity (see {@link delegatedUserIdSchema} and
 * `billingPrincipalSchema`). A plain `string` — and therefore any id read out
 * of a header, a JWT claim or a request body — is not assignable to it; the
 * only way to obtain one is to parse a value through this schema.
 */
export const oxyAccountIdSchema = z.string().min(1).max(64).brand<'OxyAccountId'>();

/** One path segment of a canonical model id: a lowercase, URL-safe slug. */
const SLUG_PATTERN = '[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?';

/**
 * A routing-profile slug, e.g. `auto`, `fast`, `quality`.
 *
 * Deliberately refuses a `/`, so a profile can never be written in the shape of
 * a model id and no caller can be confused about whether they asked for a
 * concrete model or for Oxy to choose one. Modes like `auto`/`fast`/`quality`
 * are profiles or product presets; they are never model objects.
 */
export const routingProfileSlugSchema = z
  .string()
  .max(64)
  .regex(new RegExp(`^${SLUG_PATTERN}$`), 'routing profile must be a lowercase URL-safe slug');

/**
 * The opaque PostgreSQL identity of one routing profile.
 *
 * No trim, case-folding or format heuristic: callers selecting by id must name
 * the exact stored bytes. The database lookup is the authority for existence.
 */
export const routingProfileIdSchema = z.string().min(1).max(128);

/** An inference provider slug, e.g. `openai`, `bedrock`, `oxy-hosted`. */
export const inferenceProviderSlugSchema = z
  .string()
  .max(64)
  .regex(new RegExp(`^${SLUG_PATTERN}$`), 'provider must be a lowercase URL-safe slug');

/**
 * A deployment/endpoint id. Opaque to customers: which concrete endpoint served
 * a request is the data plane's operational detail, and only the customer-safe
 * subset of it is ever attributed back (see the catalogue's serving-boundary
 * rules).
 */
export const deploymentIdSchema = z.string().min(1).max(128);

/**
 * The economic tier of the provider capacity that funds a request, in the
 * order Kaana spends it: `free` (costs nothing), `credit` (a promotional or
 * trial grant, or a prepaid balance), `paid` (ordinary metered spend).
 *
 * Kaana owns provider keys, their economics and which key serves (Oxy ADR
 * 0038, Kaana ADR 0001); Oxy owns what a customer may spend. The tier is the
 * one economic fact the two exchange: Oxy BOUNDS a route by it
 * (`maxFundingTier`), and Kaana REPORTS the tier that served
 * (`normalizedUsageReportSchema.fundingTier`). No key id, label or price
 * travels with it.
 */
export const inferenceFundingTierSchema = z.enum(['free', 'credit', 'paid']);

export type OxyAccountId = z.infer<typeof oxyAccountIdSchema>;
export type InferenceFundingTier = z.infer<typeof inferenceFundingTierSchema>;
