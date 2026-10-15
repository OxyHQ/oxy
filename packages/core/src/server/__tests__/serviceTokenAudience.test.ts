import { describe, expect, it, jest } from '@jest/globals';

import { OxyServer } from '../OxyServer';

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

const tokenWith = (aud: string) =>
  `${Buffer.from('{}').toString('base64url')}.${Buffer.from(
    JSON.stringify({
      aud,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
    }),
  ).toString('base64url')}.fixture`;

jest.mock('../workloadIdentity', () => ({
  canAttestWorkloadIdentity: () => Boolean(process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI),
  requestWorkloadServiceToken: jest.fn(async (options: { audience?: string }) => ({
    token: tokenWith(options.audience ?? 'oxy-api'),
    expiresIn: 300,
    appName: 'Alia',
  })),
}));

import { requestWorkloadServiceToken } from '../workloadIdentity';

const attestations = requestWorkloadServiceToken as unknown as jest.Mock;

function credentialClient() {
  const oxy = new OxyServer({
    baseURL: 'http://test.invalid',
    serviceAuth: { apiKey: 'oxy_dk_svc', apiSecret: 'secret-value' },
  });
  const request = jest.spyOn(oxy, 'request').mockImplementation((async (
    _method: string,
    _path: string,
    body: { audience?: string },
  ) => ({
    token: tokenWith(body.audience ?? 'oxy-api'),
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
});
