import { createHash } from 'node:crypto';
import { capabilityAuditIdempotencyKeyHash } from '../capabilityAuditCorrelation';

describe('capability audit idempotency correlation', () => {
  it('hashes a raw key once', () => {
    expect(capabilityAuditIdempotencyKeyHash({ idempotencyKey: 'run:tool' }))
      .toBe(createHash('sha256').update('run:tool').digest('hex'));
  });

  it('preserves an app-provided SHA-256 digest without hashing it again', () => {
    const digest = createHash('sha256').update('run:tool').digest('hex');
    expect(capabilityAuditIdempotencyKeyHash({ idempotencyKeyHash: digest })).toBe(digest);
  });
});
