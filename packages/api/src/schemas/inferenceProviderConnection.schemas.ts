/**
 * Request shapes for `/inference/provider-connections` (issue #972 workstream 10).
 *
 * ## The one that matters
 *
 * {@link providerCredentialBody} is the only schema in this repository that
 * accepts a third party's credential, and it is `.strict()` for a reason that is
 * not stylistic: a body carrying extra keys beside the secret is refused whole
 * rather than stripped, because a stripped field still existed upstream of the
 * parse — in the request log of whatever proxied it, in an error report, in a
 * stack trace. The strict parse is the boundary at which an unexpected shape
 * stops.
 *
 * The secret is `.max(4096)`: no provider issues a credential near that, and a
 * cap is what stops the field being used to post a payload. It has no `.min(8)`
 * or format rule — provider key formats are theirs to change, and a client
 * refused for a format Oxy guessed wrong is a support ticket with no security
 * benefit.
 *
 * Nothing here echoes the secret back. The response schema is
 * `providerConnectionSchema` from `@oxyhq/contracts`, which is `.strict()` and
 * declares no field a credential could occupy.
 */

import {
  kaanaCredentialOperationActionSchema,
  providerConnectionSchema,
} from '@oxyhq/contracts';
import { z } from 'zod';

/** An id in a path segment. Bounded so a pathological path is refused early. */
const idParam = z.string().min(1).max(128);

export const providerConnectionAccountParams = z.object({ accountId: idParam }).strict();

export const providerConnectionApplicationParams = z
  .object({ applicationId: idParam })
  .strict();

export const providerConnectionParams = z.object({ connectionId: idParam }).strict();

/** Environments a credential is issued into. Mirrors `inferenceEnvironmentSchema`. */
export const providerConnectionEnvironment = z.enum(['development', 'staging', 'production']);

/**
 * The credential itself, plus everything the row needs.
 *
 * `acknowledgeProviderTerms` defaults to `false`, never `true`: an
 * acknowledgement the client did not send is not one the customer gave, and a
 * permissive default would make the provider-terms constraint decorative. The
 * create path refuses when the provider requires one and this is false.
 *
 * There is deliberately no `byokPreference`-shaped field. Whether the customer's
 * own credentials may or must be used is a ROUTING POLICY control
 * (`inference_routing_policy_versions.byok_preference`, workstream 6); saying it
 * twice is how the two come to disagree.
 */
export const providerCredentialBody = z
  .object({
    provider: z
      .string()
      .max(64)
      .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/, 'provider must be a lowercase URL-safe slug'),
    environment: providerConnectionEnvironment,
    /** The customer's own upstream provider credential. Never stored, never logged. */
    secret: z.string().min(1).max(4096),
    acknowledgeProviderTerms: z.boolean().default(false),
  })
  .strict();

/**
 * The account-scoped create. `scope` distinguishes an INHERITED connection from
 * one that applies to this account alone — the contract's `account` vs
 * `project`, which differ by inheritance rather than by id space.
 */
export const providerConnectionAccountBody = providerCredentialBody
  .extend({ scope: z.enum(['account', 'project']) })
  .strict();

/** The rotation body: a new credential and nothing else. */
export const providerConnectionRotateBody = z
  .object({ secret: z.string().min(1).max(4096) })
  .strict();

/**
 * A validation verdict, as the component that HOLDS the credential reports it.
 *
 * A closed vocabulary with no free-form message field, so a verdict can never
 * carry credential material — an error string from an upstream SDK is exactly
 * the place a key ends up quoted back.
 */
export const providerConnectionValidationBody = z
  .object({
    state: z.enum(['unvalidated', 'valid', 'invalid', 'expired']),
    failureCode: z
      .enum(['unauthorized', 'forbidden', 'not_found', 'rate_limited', 'network', 'unknown'])
      .optional(),
  })
  .strict()
  .superRefine((verdict, ctx) => {
    if (verdict.state === 'invalid' && verdict.failureCode === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failureCode'],
        message: 'an invalid credential must record why the check failed',
      });
    }
  });

/** The read a data plane performs before serving: which connection applies. */
export const providerConnectionEffectiveQuery = z
  .object({
    provider: z.string().min(1).max(64),
    environment: providerConnectionEnvironment,
  })
  .strict();

/** Audit trail paging. Capped so one request cannot pull a whole account's trail. */
export const providerConnectionAuditQuery = z
  .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
  .strict();

/** An empty body, for the transitions that take no input. */
export const providerConnectionEmptyBody = z.object({}).strict();

/** Exact successful reconciliation response; metadata-only by contract. */
export const providerConnectionReconcileResponseSchema = z
  .object({
    data: providerConnectionSchema,
    reconciledAction: kaanaCredentialOperationActionSchema,
  })
  .strict();
