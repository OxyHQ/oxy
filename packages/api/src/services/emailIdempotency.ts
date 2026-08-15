import { createHash } from 'node:crypto';
import { EMAIL_DOMAIN } from '../config/email.config';

/**
 * Derive the RFC Message-ID used for a client retry key. The user id is part
 * of the input so the same key can safely be reused by different accounts.
 */
export function idempotentMessageId(userId: string, idempotencyKey: string): string {
  const digest = createHash('sha256')
    .update(`${userId}\0${idempotencyKey}`)
    .digest('hex')
    .slice(0, 40);
  return `<${digest}@${EMAIL_DOMAIN}>`;
}

export function idempotencyCacheKey(userId: string, idempotencyKey: string): string {
  const digest = createHash('sha256')
    .update(`${userId}\0${idempotencyKey}`)
    .digest('hex');
  return `email:send:idempotency:${digest}`;
}
