/**
 * Request shapes for the routing policy control plane (issue #972, workstream 6).
 *
 * ## This is a WHITELIST, not a second validator
 *
 * `routingPolicySchema` in `@oxyhq/contracts` owns what a valid policy IS,
 * including the refinement that rejects contradictory ones. Nothing here
 * restates any of that: {@link routingPolicyControlsBody} lists the fields a
 * CUSTOMER may set, built out of the contract's own leaf schemas
 * (`routingTargetSchema`, `routingFallbackPolicySchema`, `unitPriceSchema`,
 * `inferenceProviderSlugSchema`, …), and the service assembles the result into a
 * complete policy and runs the contract's schema over THAT.
 *
 * The list exists because a route must never spread a request body: the identity
 * fields a policy carries (`routingPolicyId`, `policyVersion`, `scope`) are the
 * server's, and a body that could set them would let a caller rewind its own
 * version counter or re-point a policy at another account. `.strict()` makes an
 * unrecognised field an error rather than something silently dropped — a
 * silently dropped `scope` is a caller who believes they set one.
 *
 * ## What storage adds on top: BOUNDS
 *
 * The contract does not cap the length of the list controls, because on the wire
 * an over-long list is merely a policy nothing matches. Here it is rows, so each
 * array carries a maximum. These are the only limits added, and they are limits
 * on SIZE, never on meaning — a bound that changed which policies are valid
 * would be the second validator this file exists to avoid.
 *
 * A drift gate rides on the call site rather than on a duplicated type: the
 * service takes `RoutingPolicyControls`, which is derived from the contract type
 * by subtraction, so a control added to the contract and forgotten here fails
 * `tsc` where the parsed body is passed in.
 */

import { z } from 'zod';
import {
  currencyCodeSchema,
  exactDecimalSchema,
  inferenceProviderSlugSchema,
  inferenceRegionSchema,
  routingFallbackPolicySchema,
  routingTargetSchema,
  unitPriceSchema,
  USAGE_UNITS,
} from '@oxyhq/contracts';

/**
 * How many providers, regions or licences one policy may name.
 *
 * Generous relative to the real catalogue and small enough that a single request
 * cannot write an unbounded number of array elements into a version row.
 */
const MAX_LIST_CONTROL_ENTRIES = 64;

/** Bounds the id space of a licence, matching the catalogue's own column. */
const licenseIdSchema = z.string().min(1).max(128);

export const routingPolicyControlsBody = z
  .object({
    /** Absent means every request must name its own model. */
    defaultTarget: routingTargetSchema.optional(),

    providerAllowlist: z
      .array(inferenceProviderSlugSchema)
      .max(MAX_LIST_CONTROL_ENTRIES)
      .default([]),
    providerDenylist: z
      .array(inferenceProviderSlugSchema)
      .max(MAX_LIST_CONTROL_ENTRIES)
      .default([]),

    allowedRegions: z.array(inferenceRegionSchema).max(MAX_LIST_CONTROL_ENTRIES).default([]),
    deniedRegions: z.array(inferenceRegionSchema).max(MAX_LIST_CONTROL_ENTRIES).default([]),

    requireZeroDataRetention: z.boolean(),
    prohibitTrainingOnCustomerData: z.boolean(),

    /**
     * At most one ceiling per unit is the CONTRACT's rule and the price-cap
     * table's primary key; the bound here is only "no more entries than there
     * are units", which is the point at which a longer list must contain a
     * duplicate anyway.
     */
    maxPricePerUnit: z.array(unitPriceSchema).max(USAGE_UNITS.length).default([]),
    maxPricePerRequest: z
      .object({ amount: exactDecimalSchema, currency: currencyCodeSchema })
      .strict()
      .optional(),

    optimiseFor: z.enum(['price', 'latency', 'throughput', 'balanced']),

    oxyHostedOnly: z.boolean(),

    allowedLicenseIds: z.array(licenseIdSchema).max(MAX_LIST_CONTROL_ENTRIES).default([]),
    requireCommercialUseRights: z.boolean(),

    fallback: routingFallbackPolicySchema,

    byokPreference: z.enum(['disabled', 'prefer', 'require']),
    dedicatedCapacity: z.enum(['disabled', 'prefer', 'require']),
  })
  .strict();

export type RoutingPolicyControlsBody = z.infer<typeof routingPolicyControlsBody>;

/** An Oxy row id, in the one shape every id in this database takes. */
const rowIdSchema = z.string().min(1).max(64);

export const routingPolicyParams = z.object({ policyId: rowIdSchema }).strict();
export const routingPolicyAccountParams = z.object({ accountId: rowIdSchema }).strict();
export const routingPolicyApplicationParams = z
  .object({ applicationId: rowIdSchema })
  .strict();

/**
 * A specific version, for the audit read. `policyVersion` is a positive integer
 * exactly as the contract declares it; a coercion is needed because it arrives
 * as a path segment.
 */
export const routingPolicyVersionParams = z
  .object({
    policyId: rowIdSchema,
    policyVersion: z.coerce.number().int().positive().safe(),
  })
  .strict();

/** How many route-switch notices one page returns. */
export const routeSwitchQuery = z
  .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
  .strict();

/**
 * `POST /inference/routing-policies/:policyId/archive` takes no fields.
 *
 * Named rather than written inline as `z.object({}).strict()`, because the
 * OpenAPI generator resolves a request body through the route file's own imports
 * and an inline expression is one it must refuse: the published operation would
 * otherwise say the endpoint accepts ANY body, when `.strict()` means it accepts
 * only an empty one.
 */
export const emptyBodySchema = z.object({}).strict();
