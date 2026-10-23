import { describe, expect, it, jest } from '@jest/globals';

import { OxyServer } from '../OxyServer';

/** Explicit credentials retain external authority; ordinary own-service clients use infrastructure identity. */

// One clock read: two could straddle a second and mint a 301 s token, which the
// cache rightly refuses to reuse (OXY_SERVICE_TOKEN_MAX_LIFETIME_SECONDS).
const mockIssuedAt = Math.floor(Date.now() / 1000);
const mockToken = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ iat: mockIssuedAt, exp: mockIssuedAt + 300 })).toString('base64url')}.fixture`;

jest.mock('../workloadIdentity', () => ({
  canAttestWorkloadIdentity: () => Boolean(process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI),
  requestWorkloadServiceToken: jest.fn(async () => ({
    token: mockToken,
    expiresIn: 300,
    appName: 'Mention',
  })),
}));

import { requestWorkloadServiceToken } from '../workloadIdentity';

const attestations = requestWorkloadServiceToken as unknown as jest.Mock;

function client() {
  return new OxyServer({ baseURL: 'https://api.oxy.so' });
}

describe('service token — workload fallback', () => {
  const previous = process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;

  beforeEach(() => {
    attestations.mockClear();
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = '/v2/credentials/abc';
  });

  afterAll(() => {
    // Cleared by assignment rather than `delete`: Biome refuses `delete` on a
    // property access, and an empty value reads as "cannot attest" everywhere
    // that matters here.
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = previous ?? '';
  });

  it('attests when no credential is configured', async () => {
    await expect(client().serviceToken()).resolves.toBe(mockToken);
    expect(attestations).toHaveBeenCalledWith({ baseUrl: 'https://api.oxy.so' });
  });

  it('mints once and serves the cached token afterwards', async () => {
    const oxy = client();

    await oxy.serviceToken();
    await oxy.serviceToken();

    expect(attestations).toHaveBeenCalledTimes(1);
  });

  it('keeps explicitly configured credentials external even on an attestable workload', async () => {
    const oxy = client();
    oxy.configureServiceAuth('oxy_dk_example', 'secret-example');
    // The credential path goes to the network; failing there is fine — what
    // matters is that it did not silently attest instead.
    await oxy.serviceToken().catch(() => undefined);

    expect(attestations).not.toHaveBeenCalled();
  });

  it('still says "no credentials" where nothing can be attested', async () => {
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = '';

    await expect(client().serviceToken()).rejects.toThrow(/No workload identity is available/);
    expect(attestations).not.toHaveBeenCalled();
  });
});

describe('workload authority', () => {
  it('refuses requested scopes instead of manufacturing an internal permission list', async () => {
    const previous = process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = '/v2/credentials/scopes';
    attestations.mockClear();
    try {
      await expect(
        client().serviceToken(undefined, undefined, { scopes: ['user:read'] }),
      ).rejects.toThrow('do not request scopes');
      expect(attestations).not.toHaveBeenCalled();
    } finally {
      process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = previous ?? '';
    }
  });
});
