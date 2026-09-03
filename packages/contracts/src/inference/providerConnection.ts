/**
 * BYOK provider connections — the metadata Oxy holds about a customer's own
 * upstream provider credential.
 *
 * The credential itself is NOT here and cannot be put here. This shape carries
 * an opaque Kaana credential handle, its exact revision and validation state.
 * Three mechanisms
 * make that structural rather than a convention somebody must remember:
 *
 *  - The object is `.strict()`. A producer that attaches `apiKey`, `secret`,
 *    `token`, `privateKey` or `headers` fails the parse. Nothing is silently
 *    stripped, because a stripped field is one that still exists upstream of
 *    the parse, in a log line or an error report.
 *  - No prefix or digest derived from the credential exists in this contract;
 *    even a partial value can make a short credential recoverable by guessing.
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
  deploymentIdSchema,
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

/** Oxy-minted, case-sensitive replay identity for one exact Kaana mutation. */
export const kaanaCredentialOperationIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,128}$/, 'a Kaana credential operation id is 1-128 opaque characters');

export const kaanaCredentialOperationActionSchema = z.enum(['create', 'rotate', 'revoke']);

/** Exact immutable Oxy identity repeated by both mutation and reconciliation. */
export const kaanaCredentialIdentitySchema = z
  .object({
    provider: inferenceProviderSlugSchema,
    ownerAccountId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    connectionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    environment: inferenceEnvironmentSchema,
  })
  .strict();

const kaanaCredentialOperationActorSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      new TextEncoder().encode(value).byteLength <= 256 &&
      value === value.trim() &&
      !/[\r\n]/.test(value),
    {
      message: 'a credential operation actor is one trimmed line of at most 256 bytes',
    },
  );

const base64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Decode only enough of a strict base64 value to prove every output byte is
 * visible ASCII. Keeping this implementation local avoids a Node Buffer or
 * browser atob dependency in the universal contracts package.
 */
function isVisibleASCIIProviderCredential(value: string): boolean {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const decodedLength = (value.length / 4) * 3 - padding;
  if (decodedLength < 1 || decodedLength > 4096) return false;

  for (let offset = 0, output = 0; offset < value.length; offset += 4, output += 3) {
    const first = base64Alphabet.indexOf(value[offset] ?? '');
    const second = base64Alphabet.indexOf(value[offset + 1] ?? '');
    const third = value[offset + 2] === '=' ? 0 : base64Alphabet.indexOf(value[offset + 2] ?? '');
    const fourth = value[offset + 3] === '=' ? 0 : base64Alphabet.indexOf(value[offset + 3] ?? '');
    if (first < 0 || second < 0 || third < 0 || fourth < 0) return false;
    const finalQuartet = offset + 4 === value.length;
    if (
      finalQuartet &&
      ((padding === 2 && (second & 0x0f) !== 0) ||
        (padding === 1 && (third & 0x03) !== 0))
    ) {
      return false;
    }

    const packed = (first << 18) | (second << 12) | (third << 6) | fourth;
    const bytes = [(packed >> 16) & 0xff, (packed >> 8) & 0xff, packed & 0xff];
    const count = Math.min(3, decodedLength - output);
    for (let index = 0; index < count; index += 1) {
      const byte = bytes[index];
      if (byte === undefined || byte < 0x21 || byte > 0x7e) return false;
    }
  }
  return true;
}

const kaanaCredentialSecretBase64Schema = z
  .string()
  .min(1)
  .max(8192)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
  .refine(isVisibleASCIIProviderCredential, {
    message: 'a decoded provider credential is 1-4096 visible ASCII bytes',
  });

export const kaanaCredentialCreateMutationSchema = kaanaCredentialIdentitySchema
  .extend({
    schemaVersion: z.literal(1),
    action: z.literal('create'),
    operationId: kaanaCredentialOperationIdSchema,
    operationActor: kaanaCredentialOperationActorSchema,
    secretBase64: kaanaCredentialSecretBase64Schema,
  })
  .strict();

export const kaanaCredentialRotateMutationSchema = kaanaCredentialIdentitySchema
  .extend({
    schemaVersion: z.literal(1),
    action: z.literal('rotate'),
    operationId: kaanaCredentialOperationIdSchema,
    operationActor: kaanaCredentialOperationActorSchema,
    credentialHandle: kaanaCredentialHandleSchema,
    expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1),
    secretBase64: kaanaCredentialSecretBase64Schema,
  })
  .strict();

export const kaanaCredentialRevokeMutationSchema = kaanaCredentialIdentitySchema
  .extend({
    schemaVersion: z.literal(1),
    action: z.literal('revoke'),
    operationId: kaanaCredentialOperationIdSchema,
    operationActor: kaanaCredentialOperationActorSchema,
    credentialHandle: kaanaCredentialHandleSchema,
    expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1),
  })
  .strict();

export const kaanaCredentialMutationSchema = z.discriminatedUnion('action', [
  kaanaCredentialCreateMutationSchema,
  kaanaCredentialRotateMutationSchema,
  kaanaCredentialRevokeMutationSchema,
]);

export const kaanaCredentialCreateOutcomeRequestSchema = kaanaCredentialIdentitySchema
  .extend({
    schemaVersion: z.literal(1),
    action: z.literal('create'),
    operationId: kaanaCredentialOperationIdSchema,
  })
  .strict();

export const kaanaCredentialRotateOutcomeRequestSchema = kaanaCredentialIdentitySchema
  .extend({
    schemaVersion: z.literal(1),
    action: z.literal('rotate'),
    operationId: kaanaCredentialOperationIdSchema,
    credentialHandle: kaanaCredentialHandleSchema,
    expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1),
  })
  .strict();

export const kaanaCredentialRevokeOutcomeRequestSchema = kaanaCredentialIdentitySchema
  .extend({
    schemaVersion: z.literal(1),
    action: z.literal('revoke'),
    operationId: kaanaCredentialOperationIdSchema,
    credentialHandle: kaanaCredentialHandleSchema,
    expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1),
  })
  .strict();

export const kaanaCredentialOutcomeRequestSchema = z.discriminatedUnion('action', [
  kaanaCredentialCreateOutcomeRequestSchema,
  kaanaCredentialRotateOutcomeRequestSchema,
  kaanaCredentialRevokeOutcomeRequestSchema,
]);

export const kaanaCredentialAppliedOutcomeSchema = z
  .object({
    schemaVersion: z.literal(1),
    operationId: kaanaCredentialOperationIdSchema,
    action: kaanaCredentialOperationActionSchema,
    status: z.literal('applied'),
    credentialHandle: kaanaCredentialHandleSchema,
    revision: z.number().int().positive().safe(),
  })
  .strict();

export const kaanaCredentialConflictOutcomeSchema = z
  .object({
    schemaVersion: z.literal(1),
    operationId: kaanaCredentialOperationIdSchema,
    action: kaanaCredentialOperationActionSchema,
    status: z.literal('conflict'),
  })
  .strict();

export const kaanaCredentialOutcomeSchema = z.discriminatedUnion('status', [
  kaanaCredentialAppliedOutcomeSchema,
  kaanaCredentialConflictOutcomeSchema,
]);

/**
 * One separately authenticated check of a quarantined BYOK generation.
 *
 * This is deliberately not an inference request. It carries no prompt, user
 * response, routing policy or billing principal, and it can select only one
 * exact Kaana deployment plus one exact credential generation.
 */
export const kaanaCredentialValidationTaskSchema = kaanaCredentialIdentitySchema
  .extend({
    schemaVersion: z.literal(1),
    operationId: kaanaCredentialOperationIdSchema,
    applicationId: oxyApplicationIdSchema,
    credentialHandle: kaanaCredentialHandleSchema,
    credentialRevision: z.number().int().positive().safe(),
    deploymentId: deploymentIdSchema,
  })
  .strict();

export const kaanaCredentialValidationOutcomeStateSchema = z.enum([
  'pending',
  'valid',
  'invalid',
  'inconclusive',
]);

export const kaanaCredentialValidationFailureCodeSchema = z.enum([
  'unauthorized',
  'forbidden',
  'not_found',
  'rate_limited',
  'network',
  'unknown',
]);

/**
 * Durable result for one exact validation operation. `inconclusive` is a
 * terminal answer about the attempt, never evidence that the credential is
 * invalid; Oxy leaves the generation quarantined and may start a new exact
 * operation. Kaana reports terminal outcomes through its service principal.
 */
export const kaanaCredentialValidationOutcomeSchema = kaanaCredentialValidationTaskSchema
  .extend({
    state: kaanaCredentialValidationOutcomeStateSchema,
    failureCode: kaanaCredentialValidationFailureCodeSchema.optional(),
  })
  .strict()
  .superRefine((outcome, ctx) => {
    if (
      (outcome.state === 'pending' || outcome.state === 'valid') &&
      outcome.failureCode !== undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failureCode'],
        message: 'a valid credential validation carries no failure code',
      });
    }
    if (
      (outcome.state === 'invalid' || outcome.state === 'inconclusive') &&
      outcome.failureCode === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failureCode'],
        message: 'a failed credential validation must state its closed failure code',
      });
    }
    if (outcome.state === 'invalid' && outcome.failureCode !== 'unauthorized') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failureCode'],
        message: 'only a provider authentication refusal proves invalidity',
      });
    }
    if (outcome.state === 'inconclusive' && outcome.failureCode === 'unauthorized') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failureCode'],
        message: 'an explicit authentication refusal is invalid, not inconclusive',
      });
    }
  });

/**
 * Customer-safe view of one explicit bootstrap attempt.
 *
 * `deploymentId` is the exact Oxy catalogue row selected by the customer. The
 * internal Kaana route id remains protected; Oxy binds the two in its durable
 * ledger and signs the latter to Kaana.
 */
export const providerCredentialValidationOperationSchema = z
  .object({
    schemaVersion: z.literal(1),
    operationId: kaanaCredentialOperationIdSchema,
    connectionId: z.string().min(1).max(128),
    applicationId: oxyApplicationIdSchema,
    deploymentId: deploymentIdSchema,
    state: kaanaCredentialValidationOutcomeStateSchema,
    failureCode: kaanaCredentialValidationFailureCodeSchema.optional(),
    createdAt: inferenceTimestampSchema,
    completedAt: inferenceTimestampSchema.optional(),
  })
  .strict()
  .superRefine((operation, ctx) => {
    const terminal = operation.state !== 'pending';
    if (terminal !== (operation.completedAt !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['completedAt'],
        message: 'only a terminal validation operation has a completion time',
      });
    }
    if (
      (operation.state === 'pending' || operation.state === 'valid') &&
      operation.failureCode !== undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failureCode'],
        message: 'pending and valid validation operations carry no failure code',
      });
    }
    if (
      (operation.state === 'invalid' || operation.state === 'inconclusive') &&
      operation.failureCode === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failureCode'],
        message: 'a failed validation operation must state its closed failure code',
      });
    }
    if (operation.state === 'invalid' && operation.failureCode !== 'unauthorized') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failureCode'],
        message: 'only a provider authentication refusal proves invalidity',
      });
    }
    if (operation.state === 'inconclusive' && operation.failureCode === 'unauthorized') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failureCode'],
        message: 'an explicit authentication refusal is invalid, not inconclusive',
      });
    }
  });

/** Exact customer-selectable catalogue ids; no internal Kaana route is exposed. */
export const providerCredentialValidationDeploymentSchema = z
  .object({ deploymentId: deploymentIdSchema })
  .strict();

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

/**
 * Lifecycle of a connection. `pending_validation` is quarantined from normal
 * serving, `revoked` is terminal, and `disabled` is reversible.
 */
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
    schemaVersion: z.literal(2),
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

    // `active` is evidence that this exact credential generation passed the
    // provider check. Pending, expired or rejected credentials cannot be
    // represented as active.
    if (connection.status === 'active' && connection.validation.state !== 'valid') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status'],
        message: 'only a successfully validated credential can be active',
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
export type KaanaCredentialOperationAction = z.infer<
  typeof kaanaCredentialOperationActionSchema
>;
export type KaanaCredentialIdentity = z.infer<typeof kaanaCredentialIdentitySchema>;
export type KaanaCredentialMutation = z.infer<typeof kaanaCredentialMutationSchema>;
export type KaanaCredentialOutcomeRequest = z.infer<typeof kaanaCredentialOutcomeRequestSchema>;
export type KaanaCredentialOutcome = z.infer<typeof kaanaCredentialOutcomeSchema>;
export type KaanaCredentialValidationTask = z.infer<
  typeof kaanaCredentialValidationTaskSchema
>;
export type KaanaCredentialValidationOutcome = z.infer<
  typeof kaanaCredentialValidationOutcomeSchema
>;
export type ProviderCredentialValidationOperation = z.infer<
  typeof providerCredentialValidationOperationSchema
>;
export type ProviderCredentialValidationDeployment = z.infer<
  typeof providerCredentialValidationDeploymentSchema
>;
export type ProviderConnectionValidation = z.infer<typeof providerConnectionValidationSchema>;
export type ProviderConnectionStatus = z.infer<typeof providerConnectionStatusSchema>;
export type ProviderCredentialCustodyState = z.infer<typeof providerCredentialCustodyStateSchema>;
export type ProviderConnection = z.infer<typeof providerConnectionSchema>;
