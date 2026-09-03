import { createHash } from 'node:crypto';

/** Resolve the stored digest exactly once, whether the app sends raw or hashed material. */
export function capabilityAuditIdempotencyKeyHash(input: {
  idempotencyKey?: string;
  idempotencyKeyHash?: string;
}): string | undefined {
  if (input.idempotencyKeyHash) return input.idempotencyKeyHash;
  return input.idempotencyKey
    ? createHash('sha256').update(input.idempotencyKey).digest('hex')
    : undefined;
}
