/**
 * The routing target and the ordered authorized routes of the signed envelope.
 *
 * Moved from `@oxy.so/contracts` 4.12.0 (`src/inference/routingPolicy.ts`) by Kaana ADR 0002.
 * The routing POLICY record (`routingPolicySchema`, its scope and fallback
 * controls) stays in `@oxy.so/contracts`: it is a Console resource.
 */

import { z } from 'zod';
import { inferenceRegionSchema, modelReferenceSchema } from '../public/identifiers.js';
import { kaanaCredentialHandleSchema } from './credentialControl.js';
import {
  deploymentIdSchema,
  inferenceFundingTierSchema,
  inferenceProviderSlugSchema,
  oxyAccountIdSchema,
  routingProfileIdSchema,
} from './identifiers.js';

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
      kind: z.literal('routing_profile_id'),
      routingProfileId: routingProfileIdSchema,
    })
    .strict(),
]);

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
  /**
   * The dearest funding tier the data plane may spend on this route. Absent
   * means no ceiling. Present, the data plane walks only provider keys whose
   * STATED tier is at or below it — a key whose economics nobody stated is
   * never admitted — and refuses the route rather than fall through to a
   * dearer key. It is how Oxy authorizes a route only while credit funds it
   * (Alia Pro and Ultra spend credits only, ADR 0038). Meaningless with a
   * customer credential, which the provider bills to the customer.
   */
  maxFundingTier: inferenceFundingTierSchema.optional(),
  /**
   * Exact customer credential binding. Absence means a platform credential;
   * presence names the immutable Kaana generation this route may use.
   */
  customerProviderCredential: z
    .object({
      credentialHandle: kaanaCredentialHandleSchema,
      credentialRevision: z.number().int().positive().safe(),
      ownerAccountId: oxyAccountIdSchema,
      connectionId: z.string().min(1).max(128),
      environment: z.enum(['development', 'staging', 'production']),
    })
    .strict()
    .optional(),
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
    z
      .object({
        substitution: z.literal('same_model'),
        ...authorizedRouteFields,
      })
      .strict(),
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
    if (route.maxFundingTier !== undefined && route.customerProviderCredential !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxFundingTier'],
        message:
          'a funding ceiling bounds platform keys; a customer credential is billed to the customer',
      });
    }
    // Same rule as `modelDeploymentSchema`: a route serves specific weights. An
    // unpinned entry would leave the data plane choosing a revision, which is
    // the one substitution the customer never authorized by naming a model.
    if (!route.modelReference.includes('@')) {
      ctx.addIssue({
        code: 'custom',
        path: ['modelReference'],
        message:
          'an authorized route must pin an immutable revision (<publisher>/<model>@<revision>)',
      });
    }
  });

export type RoutingTarget = z.infer<typeof routingTargetSchema>;
export type AuthorizedRoute = z.infer<typeof authorizedRouteSchema>;
