/**
 * The GitHub JWKS cache (ADR 0057): a key GitHub rotates in is picked up, a
 * flood of unknown key ids is not a flood of fetches, and a failed refresh keeps
 * serving keys still inside their window. No database.
 */

import { generateKeyPairSync } from 'node:crypto';

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { createGithubActionsJwksResolver } from '../githubActionsOidc.service';

function jwk(kid: string) {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
}

const A = jwk('key-a');
const B = jwk('key-b');

function harness(initial: unknown[]) {
  let keys = initial;
  let fail = false;
  let fetches = 0;
  let clock = 1_000_000;
  const resolve = createGithubActionsJwksResolver({
    clock: () => clock,
    fetch: (async () => {
      fetches += 1;
      if (fail) return new Response('nope', { status: 503 });
      return new Response(JSON.stringify({ keys }), { status: 200 });
    }) as typeof fetch,
  });
  return {
    resolve,
    advance: (ms: number) => {
      clock += ms;
    },
    publish: (next: unknown[]) => {
      keys = next;
    },
    setFailing: (value: boolean) => {
      fail = value;
    },
    fetches: () => fetches,
  };
}

it('picks up a rotated-in key once the refresh floor allows', async () => {
  const h = harness([A]);
  expect(await h.resolve('key-a')).toBeDefined();
  h.publish([A, B]);
  // Inside the floor: an unknown kid does not refetch.
  expect(await h.resolve('key-b')).toBeUndefined();
  expect(h.fetches()).toBe(1);
  h.advance(61_000);
  expect(await h.resolve('key-b')).toBeDefined();
  expect(h.fetches()).toBe(2);
});

it('bounds fetches under a flood of unknown key ids', async () => {
  const h = harness([A]);
  await h.resolve('key-a');
  for (let i = 0; i < 50; i += 1) await h.resolve(`forged-${i}`);
  expect(h.fetches()).toBe(1);
});

it('keeps serving cached keys when GitHub is unavailable, until they expire', async () => {
  const h = harness([A]);
  expect(await h.resolve('key-a')).toBeDefined();
  h.setFailing(true);
  h.advance(61_000);
  expect(await h.resolve('unknown')).toBeUndefined();
  expect(await h.resolve('key-a')).toBeDefined();
  h.advance(10 * 60 * 1000);
  expect(await h.resolve('key-a')).toBeUndefined();
});

it('refuses a set carrying a private key or a short modulus', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const leaked = { ...privateKey.export({ format: 'jwk' }), kid: 'leaked', alg: 'RS256' };
  expect(await harness([leaked]).resolve('leaked')).toBeUndefined();
  const short = { ...jwk('short'), n: Buffer.alloc(128, 1).toString('base64url') };
  expect(await harness([short]).resolve('short')).toBeUndefined();
});
