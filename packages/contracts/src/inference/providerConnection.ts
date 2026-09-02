/**
 * BYOK provider connections — the metadata Oxy holds about a customer's own
 * upstream provider credential.
 *
 * The credential itself is NOT here and cannot be put here. This shape carries
 * an opaque Kaana credential handle, its exact revision, a prefix short enough
 * to be useless, a fingerprint, and validation state. Three mechanisms
 * make that structural rather than a convention somebody must remember:
 *
 *  - The object is `.strict()`. A producer that attaches `apiKey`, `secret`,
 *    `token`, `privateKey` or `headers` fails the parse. Nothing is silently
 *    stripped, because a stripped field is one that still exists upstream of
 *    the parse, in a log line or an error report.
 *  - `keyPrefix` is capped at 12 characters — shorter than any provider's
 *    usable credential — so the one field designed to show part of a key cannot
 *    be widened into showing all of it without changing the contract.
 *  - `credentialHandle` is an opaque, closed-format identifier minted by Kaana.
 *    Oxy cannot resolve it and never stores either plaintext or ciphertext.
 *
 * BYOK does not move the billing relationship: the upstream provider bills the
 * customer's own account directly, and Oxy charges only its platform fee. The
 * record says so explicitly so a receipt against a BYOK route can be read
 * correctly without consulting anything else.
 *
 * Decided in: issue #972 workstream 10.
 */

import { z } from 'zod';
import {
  inferenceEnvironmentSchema,
  inferenceProviderSlugSchema,
  inferenceTimestampSchema,
  oxyAccountIdSchema,
  oxyApplicationIdSchema,
} from './identifiers';

/**
 * How widely a connection applies.
 *
 * In the unified account graph a project IS an account, so `account` and
 * `project` differ by INHERITANCE, not by id space: an `account` connection is
 * inherited by every descendant project and application, a `project` one
 * applies to that project account alone, and an `application` one to a single
 * application. Recording which the customer chose is what makes a later
 * "why did this app use that key" answerable.
 */
export const providerConnectionScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('account'), accountId: oxyAccountIdSchema }).strict(),
  z.object({ kind: z.literal('project'), accountId: oxyAccountIdSchema }).strict(),
  z
    .object({
      kind: z.literal('application'),
      accountId: oxyAccountIdSchema,
      applicationId: oxyApplicationIdSchema,
    })
    .strict(),
]);

/** Opaque reference minted by Kaana. It is not a KMS/Vault/SSM locator. */
export const kaanaCredentialHandleSchema = z
  .string()
  .regex(/^kcred_[a-z2-7]{26}$/, 'a Kaana credential handle is kcred_ plus 26 base32 characters');

/**
 * Oxy's view of the cross-service mutation. Only `ready` may be routed.
 * `reconcile` is the fail-closed state after an outcome could not be proven.
 */
export const providerCredentialCustodyStateSchema = z.enum([
  'pending',
  'ready',
  'reconcile',
  'revoked',
]);

/** Why a credential check failed, as a closed set the Console can render. */
export const providerConnectionValidationSchema = z
  .object({
    state: z.enum(['unvalidated', 'valid', 'invalid', 'expired']),
    lastValidatedAt: inferenceTimestampSchema.optional(),
    /** Required when `invalid`: a failure nobody can act on is not a result. */
    failureCode: z
      .enum(['unauthorized', 'forbidden', 'not_found', 'rate_limited', 'network', 'unknown'])
      .optional(),
  })
  .strict();

/** Lifecycle of a connection. `revoked` is terminal; `disabled` is reversible. */
export const providerConnectionStatusSchema = z.enum([
  'pending_validation',
  'active',
  'disabled',
  'revoked',
]);

/**
 * A customer's provider connection, without secrets.
 *
 * This is the whole of what Oxy stores, and the whole of what the data plane
 * is given.
 * Resolving the opaque handle to plaintext happens only inside Kaana inference.
 */
export const providerConnectionSchema = z
  .object({
    /** See `version.ts`: exchanged with the data plane and rendered by Console. */
    schemaVersion: z.literal(1),
    connectionId: z.string().min(1).max(128),
    provider: inferenceProviderSlugSchema,
    /** The Oxy account that owns the connection and answers for its use. */
    ownerAccountId: oxyAccountIdSchema,
    scope: providerConnectionScopeSchema,
    environment: inferenceEnvironmentSchema,
    status: providerConnectionStatusSchema,
    custodyState: providerCredentialCustodyStateSchema,
    credentialHandle: kaanaCredentialHandleSchema.optional(),
    credentialRevision: z.number().int().positive().safe().optional(),
    /**
     * The leading characters of the credential, for recognition only. Capped at
     * 12 — long enough to tell two keys apart, far too short to be one.
     */
    keyPrefix: z.string().min(1).max(12),
    /** SHA-256 of the credential, so rotation is verifiable without the key. */
    fingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/, 'fingerprint must be 64 lowercase hex characters'),
    validation: providerConnectionValidationSchema,
    /**
     * Always `true` for a BYOK connection: the provider bills the customer's own
     * upstream account, and Oxy charges only its platform fee. Stated as data so
     * a receipt against this route is readable without a second lookup.
     */
    upstreamBillsCustomerDirectly: z.literal(true),
    /** Set when the provider's terms require a per-customer acknowledgement. */
    termsAcknowledgedAt: inferenceTimestampSchema.optional(),
    createdAt: inferenceTimestampSchema,
    rotatedAt: inferenceTimestampSchema.optional(),
  })
  .strict()
  .superRefine((connection, ctx) => {
    if (
      connection.validation.state === 'invalid' &&
      connection.validation.failureCode === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['validation', 'failureCode'],
        message: 'an invalid credential must record why the check failed',
      });
    }

    // A credential the provider has rejected cannot be the one live requests are
    // routed through: leaving it active turns every request on this route into a
    // customer-visible upstream failure.
    if (connection.status === 'active' && connection.validation.state === 'invalid') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status'],
        message: 'a connection whose credential failed validation cannot be active',
      });
    }

    const hasReference =
      connection.credentialHandle !== undefined && connection.credentialRevision !== undefined;
    if (
      (connection.custodyState === 'ready' || connection.custodyState === 'revoked') &&
      !hasReference
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['credentialHandle'],
        message: 'ready and revoked custody states require an exact Kaana handle and revision',
      });
    }
    if (connection.custodyState === 'pending' && hasReference) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['custodyState'],
        message: 'a pending create cannot claim a Kaana reference before Kaana acknowledges it',
      });
    }
    if (
      (connection.credentialHandle === undefined) !==
      (connection.credentialRevision === undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['credentialRevision'],
        message: 'a Kaana credential handle and revision are present or absent together',
      });
    }
  });

export type ProviderConnectionScope = z.infer<typeof providerConnectionScopeSchema>;
export type ProviderConnectionValidation = z.infer<typeof providerConnectionValidationSchema>;
export type ProviderConnectionStatus = z.infer<typeof providerConnectionStatusSchema>;
export type ProviderCredentialCustodyState = z.infer<typeof providerCredentialCustodyStateSchema>;
export type ProviderConnection = z.infer<typeof providerConnectionSchema>;
