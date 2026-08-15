/**
 * Routing policy — the customer-facing routing configuration.
 *
 * Stored under an Oxy account or application (the control plane owns it),
 * executed by the data plane, which owns execution. Every request records the
 * exact `{routingPolicyId, policyVersion}` it was served under, so a route
 * decision months old can be explained against the policy that was in force,
 * not against the policy that exists now.
 *
 * Two rules shape the fallback controls:
 *
 *  - **Same-model deployment failover is not cross-model fallback.** Moving
 *    between two deployments of the SAME revision is an availability decision
 *    and is on by default; serving a DIFFERENT model is a substitution the
 *    customer must have authorized by name.
 *  - **A request for a concrete model is never silently replaced.** Cross-model
 *    fallback is an explicit list of references, and a switch that uses it emits
 *    a customer-visible route-switch event.
 *
 * The controls are flat and independent, matching what Console renders — which
 * means contradictory combinations are EXPRESSIBLE and must therefore be
 * REJECTED, rather than being quietly resolved by whichever field the executor
 * happens to read first. That rejection is `routingPolicySchema`'s refinement.
 *
 * Decided in: docs/adr/0008-catalogue-concept-separation.md, issue #972 workstream 6.
 */

import { z } from 'zod';
import {
  inferenceProviderSlugSchema,
  inferenceRegionSchema,
  inferenceTimestampSchema,
  modelReferenceSchema,
  oxyAccountIdSchema,
  oxyApplicationIdSchema,
  routingProfileSlugSchema,
} from './identifiers';
import { exactDecimalSchema, currencyCodeSchema, unitPriceSchema } from './money';

/**
 * What a policy resolves to when a caller names no model.
 *
 * A discriminated union rather than two optional fields, so "which one did the
 * customer configure" is never a question about which field is non-null.
 */
export const routingTargetSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('model'),
      modelReference: modelReferenceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('routing_profile'),
      routingProfile: routingProfileSlugSchema,
    })
    .strict(),
]);

/**
 * Which account or application a policy governs.
 *
 * Application-scoped policies are the common case; an account-scoped policy is
 * the floor its applications inherit, and inheritance is resolved by the control
 * plane before a policy reaches the data plane.
 */
export const routingPolicyScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('account'), accountId: oxyAccountIdSchema }).strict(),
  z
    .object({
      kind: z.literal('application'),
      accountId: oxyAccountIdSchema,
      applicationId: oxyApplicationIdSchema,
    })
    .strict(),
]);

/**
 * The fallback controls, kept together so a reviewer sees all three at once.
 *
 * `authorizedCrossModel` is a list of model references the customer has
 * explicitly permitted as substitutes — never a boolean, because "allow
 * fallback" without naming the destination is exactly the silent substitution
 * the invariant forbids.
 */
export const routingFallbackPolicySchema = z
  .object({
    disabled: z.boolean(),
    sameModelDeployment: z.boolean(),
    authorizedCrossModel: z.array(modelReferenceSchema).default([]),
  })
  .strict();

/**
 * A versioned routing policy.
 *
 * `policyVersion` is the CUSTOMER's revision of their own configuration and is
 * unrelated to `schemaVersion`, which is the version of this wire shape. They
 * are two different clocks: a customer edits their policy without any contract
 * change, and a contract change does not renumber anybody's policy.
 */
export const routingPolicySchema = z
  .object({
    /** See `version.ts`: exchanged with the data plane on its own. */
    schemaVersion: z.literal(1),
    routingPolicyId: z.string().min(1).max(128),
    policyVersion: z.number().int().positive().safe(),
    scope: routingPolicyScopeSchema,
    /** Absent when every request must name its own model. */
    defaultTarget: routingTargetSchema.optional(),

    /** Empty means "no allowlist" — every provider qualifies unless denied. */
    providerAllowlist: z.array(inferenceProviderSlugSchema).default([]),
    providerDenylist: z.array(inferenceProviderSlugSchema).default([]),

    /** Empty means "no residency constraint". */
    allowedRegions: z.array(inferenceRegionSchema).default([]),
    deniedRegions: z.array(inferenceRegionSchema).default([]),

    requireZeroDataRetention: z.boolean(),
    prohibitTrainingOnCustomerData: z.boolean(),

    /** Ceilings on what a route may cost the customer, quoted like catalogue prices. */
    maxPricePerUnit: z.array(unitPriceSchema).default([]),
    maxPricePerRequest: z
      .object({ amount: exactDecimalSchema, currency: currencyCodeSchema })
      .strict()
      .optional(),

    /** What to optimise for among the routes that qualify. */
    optimiseFor: z.enum(['price', 'latency', 'throughput', 'balanced']),

    /** Serve only from Oxy's own hosting of open-weight models. */
    oxyHostedOnly: z.boolean(),

    /** License / usage-right constraints. Empty license list means unconstrained. */
    allowedLicenseIds: z.array(z.string().min(1).max(128)).default([]),
    requireCommercialUseRights: z.boolean(),

    fallback: routingFallbackPolicySchema,

    /** Whether the customer's own provider credentials may or must be used. */
    byokPreference: z.enum(['disabled', 'prefer', 'require']),

    /** Enterprise reserved capacity rather than shared endpoints. */
    dedicatedCapacity: z.enum(['disabled', 'prefer', 'require']),

    updatedAt: inferenceTimestampSchema,
  })
  .superRefine((policy, ctx) => {
    // "Requires a denied provider": the allowlist is the requirement, so a
    // provider named in both lists is a policy that can never resolve. This is
    // also the shape an Oxy-hosted-only policy takes when it pins a provider it
    // has itself denied — whether a provider is Oxy-hosted is a property of the
    // catalogue entry, not of its slug, so the data plane resolves it, not this
    // schema.
    const denied = new Set(policy.providerDenylist);
    for (const [index, provider] of policy.providerAllowlist.entries()) {
      if (denied.has(provider)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['providerAllowlist', index],
          message: `provider ${provider} is both required by the allowlist and denied`,
        });
      }
    }

    const deniedRegions = new Set(policy.deniedRegions);
    for (const [index, region] of policy.allowedRegions.entries()) {
      if (deniedRegions.has(region)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['allowedRegions', index],
          message: `region ${region} is both allowed and denied`,
        });
      }
    }

    // Fallback disabled is an instruction to fail the request rather than serve
    // it elsewhere. Combined with a fallback route it is not a strict policy but
    // an ambiguous one, and the ambiguity resolves differently in each executor.
    if (policy.fallback.disabled && policy.fallback.sameModelDeployment) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fallback', 'sameModelDeployment'],
        message: 'fallback is disabled, so same-model deployment failover cannot be enabled',
      });
    }

    if (policy.fallback.disabled && policy.fallback.authorizedCrossModel.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fallback', 'authorizedCrossModel'],
        message: 'fallback is disabled, so no cross-model fallback may be authorized',
      });
    }

    // BYOK routes run on the customer's own upstream provider account, which is
    // by definition not Oxy's hosting.
    if (policy.oxyHostedOnly && policy.byokPreference === 'require') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['byokPreference'],
        message: 'an Oxy-hosted-only policy cannot also require a customer provider credential',
      });
    }

    const ceilingUnits = policy.maxPricePerUnit.map((ceiling) => ceiling.unit);
    if (new Set(ceilingUnits).size !== ceilingUnits.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxPricePerUnit'],
        message: 'a unit may carry only one price ceiling',
      });
    }

    if (policy.maxPricePerRequest !== undefined) {
      for (const [index, ceiling] of policy.maxPricePerUnit.entries()) {
        if (ceiling.currency !== policy.maxPricePerRequest.currency) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['maxPricePerUnit', index, 'currency'],
            message: 'every price ceiling in one policy must use the same currency',
          });
        }
      }
    }
  });

/**
 * The reference a request records: which policy, at which of the customer's own
 * revisions. Embedded in the request envelope and in the settled receipt, so a
 * charge can be explained against the exact configuration that produced it.
 */
export const routingPolicyReferenceSchema = z
  .object({
    routingPolicyId: z.string().min(1).max(128),
    policyVersion: z.number().int().positive().safe(),
  })
  .strict();

export type RoutingTarget = z.infer<typeof routingTargetSchema>;
export type RoutingPolicyScope = z.infer<typeof routingPolicyScopeSchema>;
export type RoutingFallbackPolicy = z.infer<typeof routingFallbackPolicySchema>;
export type RoutingPolicy = z.infer<typeof routingPolicySchema>;
export type RoutingPolicyReference = z.infer<typeof routingPolicyReferenceSchema>;
