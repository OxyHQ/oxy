/** The Oxy JWKS resolver: what it caches, how often it refreshes, what it refuses. */

import { generateKeyPairSync } from 'node:crypto';
import { createOxyJwksKeyResolver } from '../jwks';

const KEY = generateKeyPairSync('ed25519');
const KEY_ID = 'cap-test-1';

describe('JWKS key resolver', () => {
  const jwk = { ...KEY.publicKey.export({ format: 'jwk' }), use: 'sig', alg: 'EdDSA', kid: KEY_ID };

  function fetchReturning(body: unknown) {
    return jest.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
  }

  it('resolves and caches a published Ed25519 key', async () => {
    const fetchImpl = fetchReturning({ keys: [jwk] });
    const resolve = createOxyJwksKeyResolver({
      jwksUrl: 'https://api.oxy.so/jwks',
      fetch: fetchImpl as never,
    });
    const key = await resolve(KEY_ID);
    expect(key?.asymmetricKeyType).toBe('ed25519');
    expect(key?.export({ format: 'jwk' })).toEqual(KEY.publicKey.export({ format: 'jwk' }));
    await resolve(KEY_ID);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rate-limits refreshes caused by unknown key ids', async () => {
    let clock = 0;
    const fetchImpl = fetchReturning({ keys: [jwk] });
    const resolve = createOxyJwksKeyResolver({
      jwksUrl: 'https://api.oxy.so/jwks',
      fetch: fetchImpl as never,
      clock: () => clock,
    });
    for (let i = 0; i < 10; i += 1) expect(await resolve(`forged-${i}`)).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    clock += 61_000;
    await resolve('forged-late');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('never accepts a key set that publishes private material', async () => {
    const privateJwk = {
      ...KEY.privateKey.export({ format: 'jwk' }),
      use: 'sig',
      alg: 'EdDSA',
      kid: KEY_ID,
    };
    const resolve = createOxyJwksKeyResolver({
      jwksUrl: 'https://api.oxy.so/jwks',
      fetch: fetchReturning({ keys: [privateJwk] }) as never,
    });
    expect(await resolve(KEY_ID)).toBeUndefined();
  });
});
