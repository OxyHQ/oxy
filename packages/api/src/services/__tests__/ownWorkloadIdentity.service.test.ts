/**
 * This process asking STS what it is, through the SAME signer (`@oxy.so/core`)
 * and the SAME verifier (`verifyWorkloadAttestation`) every mint uses — so the
 * subject and handle it learns are, by construction, the ones a token minted
 * by this task would carry. Only the two network edges are fake: the container
 * credentials endpoint and STS itself.
 */
const mockStsCalls: { url: string; headers: Record<string, string> }[] = [];
let mockStsAnswer: () => Response;

jest.mock('@oxy.so/core/server', () => {
  const actual = jest.requireActual('@oxy.so/core/server');
  const credentials = (async () =>
    new Response(
      JSON.stringify({
        AccessKeyId: 'ASIAEXAMPLE',
        SecretAccessKey: 'secret-example',
        Token: 'session-token-example',
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
  return {
    ...actual,
    attestWorkloadIdentity: jest.fn((options: { nonce: string }) =>
      actual.attestWorkloadIdentity({ ...options, fetch: credentials }),
    ),
  };
});

import { attestWorkloadIdentity } from '@oxy.so/core/server';
import {
  ownWorkloadIdentity,
  resetOwnWorkloadIdentityForTests,
} from '../ownWorkloadIdentity.service';
import {
  AttestationError,
  AwsIamAttestationVerifier,
  registerAttestationVerifier,
  workloadAttestationHandle,
} from '../workloadAttestation.service';

const ROLE = 'arn:aws:iam::237343248947:role/oxy-oxy-api-task';
const attestations = attestWorkloadIdentity as unknown as jest.Mock;
const previousUri = process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;

registerAttestationVerifier(
  new AwsIamAttestationVerifier({
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      mockStsCalls.push({ url: String(url), headers: init?.headers as Record<string, string> });
      return mockStsAnswer();
    }) as unknown as typeof fetch,
  }),
);

function stsSays(arn: string): () => Response {
  return () =>
    new Response(
      `<GetCallerIdentityResponse><GetCallerIdentityResult><Arn>${arn}</Arn></GetCallerIdentityResult></GetCallerIdentityResponse>`,
      { status: 200 },
    );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockStsCalls.length = 0;
  resetOwnWorkloadIdentityForTests();
  process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = '/v2/credentials/task';
  mockStsAnswer = stsSays(
    'arn:aws:sts::237343248947:assumed-role/oxy-oxy-api-task/0123456789abcdef',
  );
});

afterAll(() => {
  process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = previousUri ?? '';
});

describe('ownWorkloadIdentity', () => {
  it('is the ROLE STS names for this task, and the handle its tokens carry', async () => {
    await expect(ownWorkloadIdentity()).resolves.toEqual({
      provider: 'aws-iam',
      subject: ROLE,
      attestationId: workloadAttestationHandle(ROLE),
    });
    // One STS call, carrying a nonce this process signed into the proof.
    expect(mockStsCalls).toHaveLength(1);
    expect(mockStsCalls[0].url).toBe('https://sts.amazonaws.com/');
    const [{ nonce }] = attestations.mock.calls[0] as [{ nonce: string }];
    expect(nonce.length).toBeGreaterThanOrEqual(32);
    expect(mockStsCalls[0].headers['x-oxy-attestation-nonce']).toBe(nonce);
  });

  it('is null on a host with nothing to prove, without signing anything', async () => {
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = '';

    await expect(ownWorkloadIdentity()).resolves.toBeNull();
    expect(attestations).not.toHaveBeenCalled();
    expect(mockStsCalls).toHaveLength(0);
  });

  it('asks STS once per process, however many callers ask at once', async () => {
    await Promise.all([ownWorkloadIdentity(), ownWorkloadIdentity()]);
    await ownWorkloadIdentity();

    expect(mockStsCalls).toHaveLength(1);
  });

  it('does not remember a failure: the next caller asks again', async () => {
    mockStsAnswer = () => new Response('<Error/>', { status: 403 });
    await expect(ownWorkloadIdentity()).rejects.toBeInstanceOf(AttestationError);

    mockStsAnswer = stsSays(ROLE);
    await expect(ownWorkloadIdentity()).resolves.toMatchObject({ subject: ROLE });
    expect(mockStsCalls).toHaveLength(2);
  });
});
