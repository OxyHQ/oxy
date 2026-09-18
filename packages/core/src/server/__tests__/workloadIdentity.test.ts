import { describe, expect, it, jest } from '@jest/globals';

import { canAttestWorkloadIdentity, requestWorkloadServiceToken } from '../workloadIdentity';

/**
 * The client half of ADR 0026, and the two properties that decide whether it
 * works at all against the verifier in `packages/api`:
 *
 *  1. **The nonce is inside the signature.** The verifier refuses an attestation
 *     whose `SignedHeaders` omits the nonce header, so a signer that merely sets
 *     the header produces attestations that are always rejected — a failure that
 *     would only show up in production, against the real verifier.
 *  2. **The signed request is never sent to AWS.** Only Oxy replays it. A client
 *     that called STS itself would work in a test and leak an identity call per
 *     token in production.
 *
 * The signature's cryptographic correctness is AWS's to judge; what is asserted
 * here is its SHAPE, which is what the two halves have to agree on.
 */

const CREDENTIALS = {
  AccessKeyId: 'ASIAEXAMPLE',
  SecretAccessKey: 'secret-example',
  Token: 'session-token-example',
};

function harness(overrides: { tokenStatus?: number } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/auth/service-token/workload/challenge')) {
      return new Response(JSON.stringify({ data: { nonce: 'nonce-from-oxy', expiresIn: 60 } }), { status: 200 });
    }
    if (url.includes('169.254.170.2')) {
      return new Response(JSON.stringify(CREDENTIALS), { status: 200 });
    }
    if (url.endsWith('/auth/service-token/workload')) {
      const status = overrides.tokenStatus ?? 200;
      if (status !== 200) return new Response('{}', { status });
      return new Response(
        JSON.stringify({ data: { token: 'service-token', expiresIn: 3600, appName: 'Mention' } }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected request to ${url}`);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('workload identity client', () => {
  const previous = process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;

  beforeEach(() => {
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = '/v2/credentials/abc';
  });

  afterAll(() => {
    // Cleared by assignment rather than `delete`: Biome refuses `delete` on a
    // property access, and an empty value reads as "cannot attest" everywhere
    // that matters here.
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = previous ?? '';
  });

  it('knows whether this process can attest at all', () => {
    expect(canAttestWorkloadIdentity({ AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/x' } as NodeJS.ProcessEnv)).toBe(true);
    expect(canAttestWorkloadIdentity({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it('answers the challenge with a signature that covers the nonce', async () => {
    const { calls, fetchImpl } = harness();

    const granted = await requestWorkloadServiceToken({ baseUrl: 'https://api.oxy.so/', fetch: fetchImpl });

    expect(granted).toEqual({ token: 'service-token', expiresIn: 3600, appName: 'Mention' });

    const exchange = calls.find((call) => call.url.endsWith('/auth/service-token/workload'));
    const body = JSON.parse(String(exchange?.init?.body)) as {
      provider: string;
      nonce: string;
      attestation: { headers: Record<string, string> };
    };

    expect(body.provider).toBe('aws-iam');
    expect(body.nonce).toBe('nonce-from-oxy');
    expect(body.attestation.headers['x-oxy-attestation-nonce']).toBe('nonce-from-oxy');
    expect(body.attestation.headers.host).toBe('sts.amazonaws.com');
    expect(body.attestation.headers['x-amz-security-token']).toBe(CREDENTIALS.Token);
    // The property the verifier actually checks.
    expect(body.attestation.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=ASIAEXAMPLE\/\d{8}\/us-east-1\/sts\/aws4_request, SignedHeaders=[^,]*x-oxy-attestation-nonce[^,]*, Signature=[0-9a-f]{64}$/,
    );
  });

  it('never sends the signed request to AWS itself', async () => {
    const { calls, fetchImpl } = harness();

    await requestWorkloadServiceToken({ baseUrl: 'https://api.oxy.so', fetch: fetchImpl });

    expect(calls.some((call) => call.url.includes('sts.amazonaws.com'))).toBe(false);
  });

  it('carries no credential material into the request body', async () => {
    const { calls, fetchImpl } = harness();

    await requestWorkloadServiceToken({ baseUrl: 'https://api.oxy.so', fetch: fetchImpl });

    const exchange = calls.find((call) => call.url.endsWith('/auth/service-token/workload'));
    expect(String(exchange?.init?.body)).not.toContain(CREDENTIALS.SecretAccessKey);
  });

  it('throws rather than returning an empty token when Oxy refuses', async () => {
    const { fetchImpl } = harness({ tokenStatus: 403 });

    await expect(
      requestWorkloadServiceToken({ baseUrl: 'https://api.oxy.so', fetch: fetchImpl }),
    ).rejects.toThrow(/refused the workload attestation \(403\)/);
  });

  it('throws when the process has no identity to prove', async () => {
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = '';
    const { fetchImpl } = harness();

    await expect(
      requestWorkloadServiceToken({ baseUrl: 'https://api.oxy.so', fetch: fetchImpl }),
    ).rejects.toThrow(/cannot attest its identity/);
  });
});
