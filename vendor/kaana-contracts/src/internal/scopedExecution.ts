/**
 * Scoped execution (envelope v3).
 *
 * Moved from `@oxy.so/contracts` 4.12.0 (`src/inference/scopedExecution.ts`) by Kaana ADR 0002.
 */

import { z } from 'zod';
import {
  idempotencyKeySchema,
  inferenceEnvironmentSchema,
  modelReferenceSchema,
  requestIdSchema,
} from '../public/identifiers.js';
import { exactDecimalSchema } from '../public/money.js';
import { deploymentIdSchema, inferenceProviderSlugSchema } from './identifiers.js';

/** Explicit extension negotiation; never replaces the legacy 3.5 handshake. */
export const SCOPED_EXECUTION_CONTRACT_VERSION = '3.6.0' as const;

/** Scoped only; normal envelope v2 and metadata 3.5 remain unchanged. */
export const SCOPED_REQUEST_ENVELOPE_VERSION = 3 as const;

const identity = z.string().min(1).max(256);

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

const maxCost = exactDecimalSchema.refine((value) => {
  if (!exactDecimalSchema.safeParse(value).success) return false;
  const [whole, fraction = ''] = value.split('.');
  const units = BigInt(whole) * 1_000_000_000_000n + BigInt(fraction.padEnd(12, '0'));
  return units > 0n && units <= 10_000_000_000n;
}, 'scoped cost must be positive and at most 0.01 USD');

/** Restriction only: none of these identities grants catalogue eligibility. */
export const scopedExecutionAudienceSchema = z
  .object({
    permitId: identity,
    idempotencyKey: idempotencyKeySchema,
    fixtureSha256: sha256,
    expiresAt: z.string().datetime(),
    principal: z
      .object({
        accountId: identity,
        applicationId: identity,
        credentialId: identity,
        environment: inferenceEnvironmentSchema,
      })
      .strict(),
    policy: z
      .object({
        routingPolicyId: z.string().min(1).max(128),
        policyVersion: z.number().int().positive().safe(),
      })
      .strict(),
    deploymentId: deploymentIdSchema,
    provider: inferenceProviderSlugSchema,
    keyId: identity,
    modelReference: modelReferenceSchema.refine(
      (value) => value.includes('@'),
      'must pin a revision',
    ),
    upstreamModelId: identity,
    priceVersionId: identity,
    providerRateCardVersionId: identity,
    providerSourceVersion: identity,
    maxCostUsd: maxCost,
  })
  .strict();

export const scopedExecutionSchema = scopedExecutionAudienceSchema
  .extend({
    requestId: requestIdSchema,
    snapshotId: identity,
    catalogueEvidenceHash: sha256,
  })
  .strict();

export type ScopedExecutionAudience = z.infer<typeof scopedExecutionAudienceSchema>;
export type ScopedExecution = z.infer<typeof scopedExecutionSchema>;
