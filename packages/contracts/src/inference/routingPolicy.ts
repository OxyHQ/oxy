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
 * **The policy itself never crosses to the data plane.** What crosses is
 * {@link authorizedRouteSchema} — the candidate routes that SURVIVED these
 * controls, in preference order — plus {@link routingPolicyReferenceSchema} as
 * provenance for the receipt. The data plane holds no control value and needs
 * none: it fails over by taking the next entry. See ADR 0017.
 *
 * Decided in: docs/adr/0008-catalogue-concept-separation.md,
 * docs/adr/0017-authorized-routes-in-the-envelope.md, issue #972 workstream 6.
 */

import { z } from 'zod';
import {
  deploymentIdSchema,
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

/* -------------------------------------------------------------------------- */
/*  Pre-authorized routes                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What every authorized route carries, whichever kind it is.
 *
 * Exactly what EXECUTING a route needs, and nothing a policy could be
 * re-derived from. There is no price, no data-retention flag, no licence id and
 * no availability scope here: those are the values the control plane already
 * evaluated to put this entry in the list, and repeating them would invite the
 * data plane to evaluate them a second time — differently, in another language.
 *
 * `regions` is plural and matches `modelDeploymentSchema.regions`, because a
 * deployment declares every ATTESTED region it MAY serve from and choosing among
 * them is routing execution (ADR 0006). Oxy checked the whole set against the
 * customer's residency controls as a SUBSET, so any non-empty region in this
 * list is one the policy permits and the data plane's choice among them cannot
 * escape it. An empty list means no location was attested and can only survive a
 * request with no explicit regional control; it never means global. Collapsing
 * the set to one invented region would make Oxy take a decision the boundary
 * assigns elsewhere.
 */
const authorizedRouteFields = {
  /** Which concrete endpoint. Opaque to customers; the data plane's own key. */
  deploymentId: deploymentIdSchema,
  /** Always revision-pinned: the entry names the exact weights to serve. */
  modelReference: modelReferenceSchema,
  provider: inferenceProviderSlugSchema,
  regions: z.array(inferenceRegionSchema),
} as const;

/**
 * One route the control plane has already authorized for one request.
 *
 * **Authorization is an ENTRY, never a boolean.** The same stance
 * `inference_routing_policy_fallbacks` takes in storage: being allowed to serve
 * a route IS appearing here, and every entry names its destination. A flag
 * saying "substitution allowed" without naming the destination is exactly the
 * silent substitution the platform forbids, and it invents a "flag set, list
 * empty" state somebody then has to decide what to do with.
 *
 * Discriminated on `substitution`, relative to the FIRST entry — the primary
 * route Oxy resolved:
 *
 *  - `same_model` serves the same model line as the primary. This is
 *    availability failover between deployments of one model.
 *  - `cross_model` serves a DIFFERENT model line, and is expressible only with
 *    `authorizedByPolicy: true` as a literal. So "a model was substituted
 *    without the customer authorizing it" is not a sentence this contract can
 *    say — the same construction `inferenceRouteSwitchDetailSchema` uses to make
 *    the resulting route-switch event unreportable.
 */
export const authorizedRouteSchema = z
  .discriminatedUnion('substitution', [
    z.object({ substitution: z.literal('same_model'), ...authorizedRouteFields }).strict(),
    z
      .object({
        substitution: z.literal('cross_model'),
        ...authorizedRouteFields,
        /** Literal `true`: an unauthorized substitution cannot be expressed. */
        authorizedByPolicy: z.literal(true),
      })
      .strict(),
  ])
  .superRefine((route, ctx) => {
    // Same rule as `modelDeploymentSchema`: a route serves specific weights. An
    // unpinned entry would leave the data plane choosing a revision, which is
    // the one substitution the customer never authorized by naming a model.
    if (!route.modelReference.includes('@')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['modelReference'],
        message: 'an authorized route must pin an immutable revision (<publisher>/<model>@<revision>)',
      });
    }
  });

export type RoutingTarget = z.infer<typeof routingTargetSchema>;
export type RoutingPolicyScope = z.infer<typeof routingPolicyScopeSchema>;
export type RoutingFallbackPolicy = z.infer<typeof routingFallbackPolicySchema>;
export type RoutingPolicy = z.infer<typeof routingPolicySchema>;
export type RoutingPolicyReference = z.infer<typeof routingPolicyReferenceSchema>;
export type AuthorizedRoute = z.infer<typeof authorizedRouteSchema>;
