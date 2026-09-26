import { describe, expect, it, jest } from '@jest/globals';

import { OxyServer } from '../OxyServer';

/**
 * How an official service stops holding a secret WITHOUT a code change.
 *
 * `serviceToken()` has always required an api key and secret. It now falls
 * back to workload identity (ADR 0026) when there is none — which means the
 * migration for each of Oxy's own services is "delete two environment
 * variables", not "edit and redeploy an app".
 *
 * Three things have to be true for that to be safe, and each is asserted below:
 *
 *  1. A configured credential still wins. The fallback must not quietly change
 *     how an already-working service authenticates.
 *  2. With no credential AND no way to attest — a laptop, a CI box — the caller
 *     gets the same "no credentials" error as before, not a confusing failure
 *     from a container credentials endpoint that is not there.
 *  3. The token is cached, so a service does not mint one per request.
 */

jest.mock('../workloadIdentity', () => ({
  canAttestWorkloadIdentity: () => Boolean(process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI),
  requestWorkloadServiceToken: jest.fn(async () => ({
    token: 'token-from-attestation',
    expiresIn: 3600,
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
    await expect(client().serviceToken()).resolves.toBe('token-from-attestation');
    expect(attestations).toHaveBeenCalledWith({ baseUrl: 'https://api.oxy.so' });
  });

  it('mints once and serves the cached token afterwards', async () => {
    const oxy = client();

    await oxy.serviceToken();
    await oxy.serviceToken();

    expect(attestations).toHaveBeenCalledTimes(1);
  });

  it('leaves a configured credential alone', async () => {
    const oxy = client();
    oxy.configureServiceAuth('oxy_dk_example', 'secret-example');
    // The credential path goes to the network; failing there is fine — what
    // matters is that it did not silently attest instead.
    await oxy.serviceToken().catch(() => undefined);

    expect(attestations).not.toHaveBeenCalled();
  });

  it('still says "no credentials" where nothing can be attested', async () => {
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = '';

    await expect(client().serviceToken()).rejects.toThrow(/Service credentials not provided/);
    expect(attestations).not.toHaveBeenCalled();
  });
});
