/**
 * Signed customer-provider credential control (BYOK custody in Kaana).
 *
 * Moved from `@oxy.so/contracts` 4.12.0 (`src/inference/providerConnection.ts`) by Kaana ADR 0002.
 * The Console connection records (`providerConnectionSchema` and its
 * validation and custody metadata) stay in `@oxy.so/contracts`.
 */

import { z } from 'zod';
import {
  inferenceEnvironmentSchema,
  oxyApplicationIdSchema,
  PADDED_BASE64_PATTERN,
} from '../public/identifiers.js';
import { deploymentIdSchema, inferenceProviderSlugSchema } from './identifiers.js';

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
      ((padding === 2 && (second & 0x0f) !== 0) || (padding === 1 && (third & 0x03) !== 0))
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
  .regex(PADDED_BASE64_PATTERN)
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
    expectedRevision: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER - 1),
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
    expectedRevision: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER - 1),
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
    expectedRevision: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER - 1),
  })
  .strict();

export const kaanaCredentialRevokeOutcomeRequestSchema = kaanaCredentialIdentitySchema
  .extend({
    schemaVersion: z.literal(1),
    action: z.literal('revoke'),
    operationId: kaanaCredentialOperationIdSchema,
    credentialHandle: kaanaCredentialHandleSchema,
    expectedRevision: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER - 1),
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
        code: 'custom',
        path: ['failureCode'],
        message: 'a valid credential validation carries no failure code',
      });
    }
    if (
      (outcome.state === 'invalid' || outcome.state === 'inconclusive') &&
      outcome.failureCode === undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['failureCode'],
        message: 'a failed credential validation must state its closed failure code',
      });
    }
    if (outcome.state === 'invalid' && outcome.failureCode !== 'unauthorized') {
      ctx.addIssue({
        code: 'custom',
        path: ['failureCode'],
        message: 'only a provider authentication refusal proves invalidity',
      });
    }
    if (outcome.state === 'inconclusive' && outcome.failureCode === 'unauthorized') {
      ctx.addIssue({
        code: 'custom',
        path: ['failureCode'],
        message: 'an explicit authentication refusal is invalid, not inconclusive',
      });
    }
  });

export type KaanaCredentialOperationAction = z.infer<typeof kaanaCredentialOperationActionSchema>;
export type KaanaCredentialIdentity = z.infer<typeof kaanaCredentialIdentitySchema>;
export type KaanaCredentialMutation = z.infer<typeof kaanaCredentialMutationSchema>;
export type KaanaCredentialOutcomeRequest = z.infer<typeof kaanaCredentialOutcomeRequestSchema>;
export type KaanaCredentialOutcome = z.infer<typeof kaanaCredentialOutcomeSchema>;
export type KaanaCredentialValidationTask = z.infer<typeof kaanaCredentialValidationTaskSchema>;
export type KaanaCredentialValidationOutcome = z.infer<
  typeof kaanaCredentialValidationOutcomeSchema
>;
