import { describe, expect, it, jest } from '@jest/globals';

import { OxyServer, ServiceCredentialMismatchError } from '../OxyServer';

/**
 * A service token is minted FOR a resource server (Kaana ADR 0002 decision 6):
 * `oxy-api` by default, `kaana.ai` for https://kaana.ai/v1. Each is accepted by
 * its own audience alone, so the client must never answer one with the other.
 *
 *  1. `serviceToken()` is unchanged: it mints for `oxy-api` and sends no
 *     `audience`, exactly as before the field existed.
 *  2. `serviceTokenFor(audience)` names the audience on both mints — the
 *     credential's and the attested workload's.
 *  3. Audiences never share a cache entry, and invalidating a credential drops
 *     every audience it minted.
 */

const issuedAt = Math.floor(Date.now() / 1000);
const defaultScopes = ['inference:invoke', 'user:read'];
const tokenWith = (aud: string, scopes: string[] = defaultScopes, nonce = '') =>
  `${Buffer.from('{}').toString('base64url')}.${Buffer.from(
    JSON.stringify({
      aud,
      scopes,
      nonce,
      iat: issuedAt,
      exp: issuedAt + 300,
    }),
  ).toString('base64url')}.fixture`;

jest.mock('../workloadIdentity', () => ({
  canAttestWorkloadIdentity: () => Boolean(process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI),
  requestLegacyWorkloadServiceToken: jest.fn(
    async (options: { audience?: string; scopes?: string[] }) => ({
      token: tokenWith(options.audience ?? 'oxy-api', options.scopes),
      expiresIn: 300,
      appName: 'Alia',
    }),
  ),
}));

import { requestLegacyWorkloadServiceToken } from '../workloadIdentity';

const attestations = requestLegacyWorkloadServiceToken as unknown as jest.Mock;

function credentialClient() {
  const oxy = new OxyServer({
    baseURL: 'http://test.invalid',
    serviceAuth: { apiKey: 'oxy_dk_svc', apiSecret: 'secret-value' },
  });
  const request = jest.spyOn(oxy, 'request').mockImplementation((async (
    _method: string,
    _path: string,
    body: { audience?: string; scopes?: string[] },
  ) => ({
    token: tokenWith(body.audience ?? 'oxy-api', body.scopes),
    expiresIn: 300,
    appName: 'Alia',
  })) as never);
  return { oxy, request };
}

describe('service token audience — credential mint', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('serviceToken() mints for oxy-api and sends no audience', async () => {
    const { oxy, request } = credentialClient();

    await oxy.serviceToken();

    expect(request).toHaveBeenCalledWith(
      'POST',
      '/auth/service-token',
      { apiKey: 'oxy_dk_svc', apiSecret: 'secret-value' },
      expect.objectContaining({ skipAuth: true }),
    );
  });

  it('serviceTokenFor(kaana.ai) names the audience', async () => {
    const { oxy, request } = credentialClient();

    await expect(oxy.serviceTokenFor('kaana.ai')).resolves.toBe(tokenWith('kaana.ai'));
    expect(request).toHaveBeenCalledWith(
      'POST',
      '/auth/service-token',
      { apiKey: 'oxy_dk_svc', apiSecret: 'secret-value', audience: 'kaana.ai' },
      expect.objectContaining({ skipAuth: true }),
    );
  });

  it('keeps one cache entry per audience', async () => {
    const { oxy, request } = credentialClient();

    const forOxy = await oxy.serviceToken();
    const forKaana = await oxy.serviceTokenFor('kaana.ai');
    await oxy.serviceToken();
    await oxy.serviceTokenFor('kaana.ai');

    expect(forOxy).toBe(tokenWith('oxy-api'));
    expect(forKaana).toBe(tokenWith('kaana.ai'));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('invalidating the credential drops every audience it minted', async () => {
    const { oxy, request } = credentialClient();
    await oxy.serviceToken();
    await oxy.serviceTokenFor('kaana.ai');

    oxy.invalidateServiceToken('oxy_dk_svc');
    await oxy.serviceToken();
    await oxy.serviceTokenFor('kaana.ai');

    expect(request).toHaveBeenCalledTimes(4);
  });
});

describe('audience and exact scope sets compose for credential mints', () => {
  afterEach(() => jest.restoreAllMocks());
  it('separates default and normalized narrow scopes across audiences and invalidates every variant', async () => {
    const { oxy, request } = credentialClient();
    const audiences = ['oxy-api', 'kaana.ai', 'oxy-api:kaana-control'] as const;
    const scopeSets = [undefined, ['user:read'], ['user:read', 'inference:invoke']];
    for (const audience of audiences)
      for (const scopes of scopeSets) {
        const token = await oxy.serviceTokenFor(audience, undefined, undefined, { scopes });
        expect(token).toBe(tokenWith(audience, scopes?.toSorted()));
      }
    expect(request).toHaveBeenCalledTimes(9);
    await oxy.serviceTokenFor('kaana.ai', undefined, undefined, {
      scopes: ['inference:invoke', 'user:read'],
    });
    await oxy.serviceToken(undefined, undefined, { scopes: ['user:read'] });
    await expect(
      oxy.serviceTokenFor('kaana.ai', undefined, undefined, { scopes: [] }),
    ).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(9);
    oxy.invalidateServiceToken('oxy_dk_svc');
    for (const audience of audiences)
      for (const scopes of scopeSets)
        await oxy.serviceTokenFor(audience, undefined, undefined, { scopes });
    expect(request).toHaveBeenCalledTimes(18);
  });
  it('checks the supplied secret for a cached nondefault audience and scope set', async () => {
    const { oxy, request } = credentialClient();
    await oxy.serviceTokenFor('kaana.ai', undefined, undefined, { scopes: ['user:read'] });
    await expect(
      oxy.serviceTokenFor('kaana.ai', 'oxy_dk_svc', 'wrong-secret', { scopes: ['user:read'] }),
    ).rejects.toBeInstanceOf(ServiceCredentialMismatchError);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('a late mint cannot overwrite a newer token after cross-variant invalidation', async () => {
    const { oxy, request } = credentialClient();
    let resolveOld: ((value: unknown) => void) | undefined;
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }) as never,
    );
    const old = oxy.serviceTokenFor('kaana.ai', undefined, undefined, { scopes: ['user:read'] });
    await Promise.resolve();
    oxy.invalidateServiceToken();
    const fresh = await oxy.serviceTokenFor('kaana.ai', undefined, undefined, {
      scopes: ['user:read'],
    });
    if (!resolveOld) throw new Error('Mint did not start');
    resolveOld({
      token: tokenWith('kaana.ai', ['user:read'], 'old'),
      expiresIn: 300,
      appName: 'Alia',
    });
    await old;
    expect(
      await oxy.serviceTokenFor('kaana.ai', undefined, undefined, { scopes: ['user:read'] }),
    ).toBe(fresh);
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe('service token audience — attested workload', () => {
  const previous = process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;

  beforeEach(() => {
    attestations.mockClear();
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = '/v2/credentials/abc';
  });

  afterAll(() => {
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = previous ?? '';
  });

  it('asks the attestation for the audience, and for none by default', async () => {
    const oxy = new OxyServer({ baseURL: 'https://api.oxy.so' });

    await expect(oxy.serviceTokenFor('kaana.ai')).resolves.toBe(tokenWith('kaana.ai'));
    await expect(oxy.serviceToken()).resolves.toBe(tokenWith('oxy-api'));

    expect(attestations).toHaveBeenCalledWith({
      baseUrl: 'https://api.oxy.so',
      audience: 'kaana.ai',
    });
    expect(attestations).toHaveBeenCalledWith({ baseUrl: 'https://api.oxy.so' });
  });

  it('caches each audience on its own', async () => {
    const oxy = new OxyServer({ baseURL: 'https://api.oxy.so' });

    await oxy.serviceTokenFor('kaana.ai');
    await oxy.serviceTokenFor('kaana.ai');
    await oxy.serviceToken();
    await oxy.serviceToken();

    expect(attestations).toHaveBeenCalledTimes(2);
  });
  it('caches registered product audiences independently without scopes', async () => {
    const oxy = new OxyServer({ baseURL: 'https://api.oxy.so' });
    await oxy.serviceTokenFor('oxy-service:recipient');
    await oxy.serviceTokenFor('oxy-service:recipient');
    await oxy.serviceTokenFor('kaana.ai');
    expect(attestations).toHaveBeenCalledTimes(2);
    expect(attestations).toHaveBeenCalledWith({
      baseUrl: 'https://api.oxy.so',
      audience: 'oxy-service:recipient',
    });
    oxy.invalidateServiceToken();
    await oxy.serviceTokenFor('oxy-service:recipient');
    expect(attestations).toHaveBeenCalledTimes(3);
  });
});
