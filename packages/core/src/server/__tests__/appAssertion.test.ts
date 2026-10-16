/**
 * App assertions (ADR 0045): the format and `verifyAppAssertion`.
 *
 * A service reads the application a request comes from ONLY through this
 * verification, so every way to forge, stretch or move an assertion reads as
 * no app: a wrong signature, issuer, audience or type, another person's or
 * another session's assertion, an expired one, a JWKS that cannot answer.
 */

import { generateKeyPairSync, randomUUID, sign as signBytes } from 'node:crypto';
import {
  OxyAppAssertionError,
  readAppAssertionHeader,
  signOxyAppAssertion,
  verifyAppAssertion,
  verifyOxyAppAssertion,
  type OxyAppAssertionClaims,
} from '../appAssertion';

const NOW = new Date('2026-10-16T12:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const ISSUER = 'https://api.oxy.so';
const KEY = generateKeyPairSync('ed25519');
const OTHER_KEY = generateKeyPairSync('ed25519');
const KEY_ID = 'cap-test-1';
const SESSION = { userId: 'person-1', sessionId: 'session-1' };

function claims(overrides: Partial<OxyAppAssertionClaims> = {}): OxyAppAssertionClaims {
  return {
    iss: ISSUER,
    aud: 'oxy-apps',
    sub: SESSION.userId,
    sid: SESSION.sessionId,
    app: 'clarity-app',
    platform: 'ios',
    iat: NOW_SECONDS,
    exp: NOW_SECONDS + 300,
    jti: randomUUID(),
    ...overrides,
  };
}

function sign(value: OxyAppAssertionClaims = claims(), privateKey = KEY.privateKey): string {
  return signOxyAppAssertion(value, { keyId: KEY_ID, privateKey });
}

/** Hand-rolled JWS so tests can produce what the real signer refuses to. */
function rawToken(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  privateKey = KEY.privateKey,
): string {
  const input = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  return `${input}.${signBytes(null, Buffer.from(input), privateKey).toString('base64url')}`;
}

const resolvePublicKey = async (keyId: string) => (keyId === KEY_ID ? KEY.publicKey : undefined);

function verify(token: string, overrides: Partial<Parameters<typeof verifyAppAssertion>[1]> = {}) {
  return verifyAppAssertion(token, {
    session: SESSION,
    issuer: ISSUER,
    resolvePublicKey,
    now: NOW,
    ...overrides,
  });
}

describe('signOxyAppAssertion', () => {
  it('signs an OXY-APP+JWT with the key id', () => {
    const token = sign();
    const header = JSON.parse(Buffer.from(token.split('.')[0] as string, 'base64url').toString());
    expect(header).toEqual({ alg: 'EdDSA', typ: 'OXY-APP+JWT', kid: KEY_ID });
  });

  it('refuses a lifetime above five minutes, another audience or an unknown platform', () => {
    expect(() => sign(claims({ exp: NOW_SECONDS + 301 }))).toThrow(OxyAppAssertionError);
    expect(() => sign({ ...claims(), aud: 'alia' } as never)).toThrow();
    expect(() => sign({ ...claims(), platform: 'windows' } as never)).toThrow();
  });
});

describe('verifyAppAssertion', () => {
  it('reads the application and platform of an assertion for this person and session', async () => {
    await expect(verify(sign())).resolves.toEqual({
      applicationId: 'clarity-app',
      platform: 'ios',
    });
  });

  it('reads no app without a token or a verified session', async () => {
    await expect(verify('')).resolves.toBeNull();
    await expect(verifyAppAssertion(null, { session: SESSION, resolvePublicKey })).resolves.toBe(
      null,
    );
    await expect(verify(sign(), { session: null })).resolves.toBeNull();
    await expect(verify(sign(), { session: { userId: '', sessionId: 's' } })).resolves.toBeNull();
  });

  it('reads no app from another person or another session', async () => {
    await expect(verify(sign(claims({ sub: 'person-2' })))).resolves.toBeNull();
    await expect(verify(sign(claims({ sid: 'session-2' })))).resolves.toBeNull();
  });

  it('reads no app from an expired, future or overlong assertion', async () => {
    await expect(
      verify(sign(claims({ iat: NOW_SECONDS - 400, exp: NOW_SECONDS - 100 }))),
    ).resolves.toBeNull();
    await expect(
      verify(sign(claims({ iat: NOW_SECONDS - 300, exp: NOW_SECONDS }))),
    ).resolves.toBeNull();
    await expect(
      verify(sign(claims({ iat: NOW_SECONDS + 60, exp: NOW_SECONDS + 360 }))),
    ).resolves.toBeNull();
    await expect(
      verify(
        rawToken(
          { alg: 'EdDSA', typ: 'OXY-APP+JWT', kid: KEY_ID },
          claims({ exp: NOW_SECONDS + 3600 }),
        ),
      ),
    ).resolves.toBeNull();
  });

  it('reads no app from a wrong signature, an unknown key or another issuer', async () => {
    await expect(verify(sign(claims(), OTHER_KEY.privateKey))).resolves.toBeNull();
    await expect(
      verify(sign(), { resolvePublicKey: async () => OTHER_KEY.publicKey }),
    ).resolves.toBeNull();
    await expect(verify(sign(), { resolvePublicKey: async () => undefined })).resolves.toBeNull();
    await expect(verify(sign(), { issuer: 'https://api.oxy.dev' })).resolves.toBeNull();
    const [header, payload] = sign().split('.');
    await expect(verify(`${header}.${payload}.${'A'.repeat(86)}`)).resolves.toBeNull();
  });

  it('reads no app from another token type, audience or extra claims', async () => {
    await expect(
      verify(rawToken({ alg: 'EdDSA', typ: 'OXY-REQUESTER+JWT', kid: KEY_ID }, claims())),
    ).resolves.toBeNull();
    await expect(
      verify(rawToken({ alg: 'EdDSA', typ: 'JWT', kid: KEY_ID }, claims())),
    ).resolves.toBeNull();
    await expect(
      verify(
        rawToken({ alg: 'EdDSA', typ: 'OXY-APP+JWT', kid: KEY_ID }, { ...claims(), aud: 'alia' }),
      ),
    ).resolves.toBeNull();
    await expect(
      verify(
        rawToken({ alg: 'EdDSA', typ: 'OXY-APP+JWT', kid: KEY_ID }, { ...claims(), scope: 'all' }),
      ),
    ).resolves.toBeNull();
    await expect(
      verify(rawToken({ alg: 'none', typ: 'OXY-APP+JWT', kid: KEY_ID }, claims())),
    ).resolves.toBeNull();
  });

  it('reads no app when the JWKS cannot be read', async () => {
    await expect(
      verify(sign(), {
        resolvePublicKey: async () => {
          throw new Error('JWKS down');
        },
      }),
    ).resolves.toBeNull();
  });

  it('fetches the JWKS from the issuer once and caches it', async () => {
    const jwk = KEY.publicKey.export({ format: 'jwk' });
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ keys: [{ ...jwk, alg: 'EdDSA', use: 'sig', kid: KEY_ID }] }),
    }));
    const realFetch = global.fetch;
    global.fetch = fetchMock as unknown as typeof fetch;
    try {
      const issuer = 'https://api.oxy.test';
      const token = sign(claims({ iss: issuer }));
      const options = { session: SESSION, issuer, now: NOW };
      await expect(verifyAppAssertion(token, options)).resolves.toEqual({
        applicationId: 'clarity-app',
        platform: 'ios',
      });
      await expect(verifyAppAssertion(token, options)).resolves.not.toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toBe(
        'https://api.oxy.test/capabilities/.well-known/jwks.json',
      );
    } finally {
      global.fetch = realFetch;
    }
  });
});

describe('verifyOxyAppAssertion', () => {
  it('names why it refused', () => {
    const code = (run: () => unknown) => {
      try {
        run();
      } catch (error) {
        return error instanceof OxyAppAssertionError ? error.code : 'other';
      }
      return 'accepted';
    };
    const options = { publicKey: KEY.publicKey, issuer: ISSUER, now: NOW };
    expect(code(() => verifyOxyAppAssertion(sign(), options))).toBe('accepted');
    expect(code(() => verifyOxyAppAssertion('a.b', options))).toBe('malformed');
    expect(
      code(() => verifyOxyAppAssertion(sign(), { ...options, publicKey: OTHER_KEY.publicKey })),
    ).toBe('invalid_signature');
    expect(code(() => verifyOxyAppAssertion(sign(), { ...options, issuer: 'x' }))).toBe(
      'wrong_issuer',
    );
    expect(
      code(() =>
        verifyOxyAppAssertion(sign(), { ...options, now: new Date(NOW.getTime() + 301_000) }),
      ),
    ).toBe('expired');
  });
});

describe('readAppAssertionHeader', () => {
  it('reads one X-Oxy-App-Assertion and nothing else', () => {
    expect(readAppAssertionHeader({ headers: { 'x-oxy-app-assertion': 'a.b.c' } })).toBe('a.b.c');
    expect(readAppAssertionHeader({ headers: {} })).toBeNull();
    expect(readAppAssertionHeader({ headers: { 'x-oxy-app-assertion': ['a', 'b'] } })).toBeNull();
    expect(readAppAssertionHeader({ headers: { 'x-oxy-app-assertion': 'x'.repeat(5000) } })).toBe(
      null,
    );
  });
});
