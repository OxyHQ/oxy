import { createAuthorityCache } from '../authorityCache';

describe('createAuthorityCache', () => {
  it('shares one load per key, expires after the TTL, never caches errors, and lets an invalidation win over a load in flight', async () => {
    let clock = 0;
    const cache = createAuthorityCache<string>('test-authority', {
      ttlMs: () => 5_000,
      now: () => clock,
    });
    let loads = 0;
    const load = async () => `value-${++loads}`;

    // Concurrent misses: one query.
    expect(await Promise.all([cache.get('a', load), cache.get('a', load)])).toEqual([
      'value-1',
      'value-1',
    ]);
    clock = 4_999;
    expect(await cache.get('a', load)).toBe('value-1');
    clock = 5_000;
    expect(await cache.get('a', load)).toBe('value-2');

    // A failed load rejects and is asked again next time.
    await expect(cache.get('b', () => Promise.reject(new Error('db down')))).rejects.toThrow(
      'db down',
    );
    expect(await cache.get('b', load)).toBe('value-3');

    // Revocation while a read of the OLD state is in flight: the old answer
    // reaches its own caller but is not cached, so the next read is live.
    let release!: (value: string) => void;
    const stale = cache.get('c', () => new Promise<string>((resolve) => (release = resolve)));
    cache.invalidate('c');
    release('trusted-before-revocation');
    expect(await stale).toBe('trusted-before-revocation');
    expect(await cache.get('c', async () => 'revoked')).toBe('revoked');
  });
});
