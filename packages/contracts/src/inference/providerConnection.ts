/**
 * BYOK provider connections — the metadata Oxy holds about a customer's own
 * upstream provider credential.
 *
 * The credential itself is NOT here and cannot be put here. This shape carries
 * a locator (`secretRef`) into Vault/KMS/managed secret storage, a prefix short
 * enough to be useless, a fingerprint, and validation state. Three mechanisms
 * make that structural rather than a convention somebody must remember:
 *
 *  - The object is `.strict()`. A producer that attaches `apiKey`, `secret`,
 *    `token`, `privateKey` or `headers` fails the parse. Nothing is silently
 *    stripped, because a stripped field is one that still exists upstream of
 *    the parse, in a log line or an error report.
 *  - `keyPrefix` is capped at 12 characters — shorter than any provider's
 *    usable credential — so the one field designed to show part of a key cannot
 *    be widened into showing all of it without changing the contract.
 *  - `secretRef` is DERIVED, not free text: the grammar is closed and the
 *    refinement below requires it to be this connection's own environment,
 *    owner account and id under one namespace. A field with no free span is a
 *    field a credential cannot be smuggled through.
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

/**
 * The managed secret stores a reference may point into.
 *
 * A closed set, because the scheme is the half of a locator that says who can
 * resolve it: a scheme nothing in this system can dereference is not a
 * reference. Restated as a SQL alternation in
 * `packages/api/src/db/schema/inferenceProviderConnections.ts`, and that file's
 * schema test holds the two equal.
 */
const SECRET_STORE_NAMES = ['vault', 'kms', 'ssm', 'secretsmanager'] as const;

/**
 * The namespace every Oxy BYOK locator lives under, whichever store holds it.
 *
 * Part of the grammar rather than an implementation detail of the writer: it is
 * the prefix a store-side IAM or Vault policy is scoped to, so a locator outside
 * it is one Oxy's own credentials could not resolve anyway.
 */
export const PROVIDER_SECRET_REFERENCE_NAMESPACE = 'oxy/inference/byok';

/**
 * The two id segments, bounded exactly as the fields they must equal are:
 * `oxyAccountIdSchema` caps an account id at 64 characters and
 * `providerConnectionSchema.connectionId` caps a connection id at 128. A tighter
 * bound here would refuse a reference to a connection the same contract accepts.
 */
const ACCOUNT_SEGMENT = '[A-Za-z0-9_-]{1,64}';
const CONNECTION_SEGMENT = '[A-Za-z0-9_-]{1,128}';

/**
 * A locator for the credential in managed secret storage — never the credential.
 *
 * The grammar is CLOSED, and that is the whole of its value: a store from a
 * four-name set, one fixed namespace, an environment from a three-name set, and
 * two bounded id segments. Nothing may precede, follow or be interpolated
 * between them, so there is no free-form span for credential material to occupy:
 * the only places anything a producer chooses can sit are the two ids, and
 * `providerConnectionSchema` below pins those to THIS connection's own owner
 * account and id.
 *
 * ## It was not always closed, and the difference was measured
 *
 * The previous grammar was `<store>:<anything from a wide charset>`, under a
 * comment claiming that meant "a producer cannot pass a raw key through this
 * field and have it look like a reference". It did not. Splicing a credential in
 * after the store name —
 * `vault:sk-ant-api03-…/oxy/inference/byok/production/<account>/<id>` — satisfied
 * that regex, satisfied the storage partition CHECK (which pins the END of the
 * string and said nothing about its start), and parsed cleanly. Both mechanisms
 * constrained the SHAPE of the locator; neither constrained what could be put in
 * front of it. `packages/api`'s `providerSecretLeak.test.ts` plants exactly that
 * value, and it is now refused here, by the CHECK, and by the refinement below.
 */
export const providerSecretReferenceSchema = z
  .string()
  .regex(
    new RegExp(
      `^(?:${SECRET_STORE_NAMES.join('|')}):${PROVIDER_SECRET_REFERENCE_NAMESPACE}/` +
        `(?:${inferenceEnvironmentSchema.options.join('|')})/${ACCOUNT_SEGMENT}/${CONNECTION_SEGMENT}$`,
    ),
    'a secret reference is <store>:oxy/inference/byok/<environment>/<accountId>/<connectionId>, ' +
      'never credential material',
  );

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
 * Resolving `secretRef` to credential material happens in the secret store, at
 * use time, in the data plane — never in a database row, an API response, a
 * Console screen or a log line.
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
    secretRef: providerSecretReferenceSchema,
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

    // The reference is a FUNCTION of this record, not a value a producer chooses:
    // the store, then the namespace, then this connection's own environment,
    // owner account and id. `providerSecretReferenceSchema` already refuses
    // anything outside the grammar; this is what closes the two id segments, the
    // only spans left that a producer picks the contents of.
    //
    // The same rule the `inference_provider_connections_secret_ref_partition`
    // CHECK enforces on the row. Both exist because they cover different
    // producers: the CHECK protects the TABLE from a backfill or a service that
    // skipped the parse, and this protects the WIRE from a producer that never
    // touches the table — the data plane echoing a connection back, or a future
    // service building a DTO by hand.
    const expected = SECRET_STORE_NAMES.map(
      (store) =>
        `${store}:${PROVIDER_SECRET_REFERENCE_NAMESPACE}/${connection.environment}/` +
        `${connection.ownerAccountId}/${connection.connectionId}`,
    );
    if (!expected.includes(connection.secretRef)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['secretRef'],
        message:
          'a secret reference must name this connection: ' +
          '<store>:oxy/inference/byok/<environment>/<ownerAccountId>/<connectionId>',
      });
    }
  });

export type ProviderConnectionScope = z.infer<typeof providerConnectionScopeSchema>;
export type ProviderConnectionValidation = z.infer<typeof providerConnectionValidationSchema>;
export type ProviderConnectionStatus = z.infer<typeof providerConnectionStatusSchema>;
export type ProviderConnection = z.infer<typeof providerConnectionSchema>;
