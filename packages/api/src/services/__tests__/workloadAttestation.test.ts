/**
 * The AWS attestation verifier, and the four ways it must say no.
 *
 * Every case here is an attack, not a typo. The verifier's whole job is to turn
 * "a request the caller signed" into "who AWS says signed it", and it is the one
 * place in the workload-identity path where believing the caller would be fatal:
 *
 *  1. **It must not be a general-purpose HTTP client.** A signed request is an
 *     arbitrary request this service would otherwise make on the caller's word —
 *     SSRF with a signature attached — so anything not addressed to STS is
 *     refused before a byte leaves the process. The look-alike host case is the
 *     one a suffix check passes.
 *  2. **The nonce must be inside the signature.** A nonce that is merely present
 *     can be swapped by whoever captured the attestation, which makes a captured
 *     attestation a permanent impersonation.
 *  3. **It must be recent.** Signatures do not stop being valid on their own.
 *  4. **AWS decides who the caller is.** The ARN comes from STS's answer; there
 *     is deliberately no path where the payload can name it.
 */

import {
  AttestationError,
  AwsIamAttestationVerifier,
  ATTESTATION_NONCE_HEADER,
  canonicalAwsSubject,
  workloadAttestationHandle,
} from '../workloadAttestation.service';

const NONCE = 'challenge-nonce-value';
const ARN = 'arn:aws:sts::237343248947:assumed-role/oxy-mention-task/abc123';

const SIGNED_AT = Date.UTC(2026, 8, 18, 4, 15, 0);
const amzDate = (at: number) => new Date(at).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

function attestation(overrides: Record<string, string> = {}) {
  return {
    headers: {
      host: 'sts.amazonaws.com',
      'x-amz-date': amzDate(SIGNED_AT),
      authorization:
        `AWS4-HMAC-SHA256 Credential=AKIA/20260918/us-east-1/sts/aws4_request, ` +
        `SignedHeaders=host;x-amz-date;${ATTESTATION_NONCE_HEADER}, Signature=deadbeef`,
      [ATTESTATION_NONCE_HEADER]: NONCE,
      ...overrides,
    },
  };
}

function stsResponder(body: string, ok = true) {
  const fetchImpl = jest.fn(async () =>
    new Response(body, { status: ok ? 200 : 403 }),
  ) as unknown as typeof fetch;
  return fetchImpl;
}

const IDENTITY_XML = `<GetCallerIdentityResponse><GetCallerIdentityResult><Arn>${ARN}</Arn></GetCallerIdentityResult></GetCallerIdentityResponse>`;

function verifierWith(fetchImpl: typeof fetch) {
  return new AwsIamAttestationVerifier({ fetch: fetchImpl, now: () => SIGNED_AT + 1_000 });
}

describe('AwsIamAttestationVerifier', () => {
  it('believes the ARN STS answers with, not anything in the payload', async () => {
    const fetchImpl = stsResponder(IDENTITY_XML);
    const verified = await verifierWith(fetchImpl).verify(attestation(), NONCE);

    // The ROLE, not the per-task session STS actually answered with.
    expect(verified).toMatchObject({
      provider: 'aws-iam',
      subject: 'arn:aws:iam::237343248947:role/oxy-mention-task',
    });
    expect(verified.attestationId).toMatch(/^wl_[0-9a-f]{24}$/);
  });

  it('replays the caller’s headers but never the caller’s method, path or body', async () => {
    const fetchImpl = stsResponder(IDENTITY_XML);
    await verifierWith(fetchImpl).verify(attestation(), NONCE);

    const [url, init] = (fetchImpl as unknown as jest.Mock).mock.calls[0];
    expect(url).toBe('https://sts.amazonaws.com/');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('Action=GetCallerIdentity&Version=2011-06-15');
  });

  it.each([
    ['a host that is not STS at all', 'internal-admin.oxy.so'],
    ['a look-alike a suffix check would accept', 'sts.amazonaws.com.attacker.example'],
    ['a look-alike prefix', 'not-sts.amazonaws.com'],
  ])('refuses %s without calling it', async (_label, host) => {
    const fetchImpl = stsResponder(IDENTITY_XML);

    await expect(verifierWith(fetchImpl).verify(attestation({ host }), NONCE)).rejects.toMatchObject({
      reason: 'host_not_sts',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('accepts a regional STS endpoint', async () => {
    const fetchImpl = stsResponder(IDENTITY_XML);
    const verified = await verifierWith(fetchImpl).verify(attestation({ host: 'sts.us-west-2.amazonaws.com' }), NONCE);
    expect(verified.subject).toBe('arn:aws:iam::237343248947:role/oxy-mention-task');
  });

  it('resolves two tasks of one service to the SAME subject', async () => {
    const first = await verifierWith(
      stsResponder(IDENTITY_XML.replace('/abc123', '/task-one')),
    ).verify(attestation(), NONCE);
    const second = await verifierWith(
      stsResponder(IDENTITY_XML.replace('/abc123', '/task-two')),
    ).verify(attestation(), NONCE);

    // The whole point: a binding names a role, and a role outlives its tasks.
    expect(first.subject).toBe(second.subject);
    expect(first.attestationId).toBe(second.attestationId);
  });

  it('refuses a nonce the signature does not cover', async () => {
    const fetchImpl = stsResponder(IDENTITY_XML);
    const unsignedNonce = attestation({
      authorization:
        'AWS4-HMAC-SHA256 Credential=AKIA/20260918/us-east-1/sts/aws4_request, ' +
        'SignedHeaders=host;x-amz-date, Signature=deadbeef',
    });

    await expect(verifierWith(fetchImpl).verify(unsignedNonce, NONCE)).rejects.toMatchObject({
      reason: 'nonce_unsigned',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses an attestation that answers a different challenge', async () => {
    const fetchImpl = stsResponder(IDENTITY_XML);

    await expect(
      verifierWith(fetchImpl).verify(attestation({ [ATTESTATION_NONCE_HEADER]: 'someone-elses-nonce' }), NONCE),
    ).rejects.toMatchObject({ reason: 'nonce_mismatch' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a signature older than the window', async () => {
    const verifier = new AwsIamAttestationVerifier({
      fetch: stsResponder(IDENTITY_XML),
      now: () => SIGNED_AT + 10 * 60 * 1000,
    });

    await expect(verifier.verify(attestation(), NONCE)).rejects.toMatchObject({ reason: 'stale' });
  });

  it('refuses a signature dated in the future by more than the window', async () => {
    const verifier = new AwsIamAttestationVerifier({
      fetch: stsResponder(IDENTITY_XML),
      now: () => SIGNED_AT - 10 * 60 * 1000,
    });

    await expect(verifier.verify(attestation(), NONCE)).rejects.toMatchObject({ reason: 'stale' });
  });

  it('refuses an unsigned request', async () => {
    await expect(
      verifierWith(stsResponder(IDENTITY_XML)).verify(attestation({ authorization: 'Bearer something' }), NONCE),
    ).rejects.toMatchObject({ reason: 'unsigned' });
  });

  it.each([
    ['no object at all', 'not-an-object'],
    ['no headers', {}],
    ['headers that are not strings', { headers: { host: 42 } }],
  ])('refuses a payload with %s', async (_label, payload) => {
    await expect(verifierWith(stsResponder(IDENTITY_XML)).verify(payload, NONCE)).rejects.toBeInstanceOf(
      AttestationError,
    );
  });

  it('refuses when AWS refuses', async () => {
    await expect(
      verifierWith(stsResponder('<ErrorResponse/>', false)).verify(attestation(), NONCE),
    ).rejects.toMatchObject({ reason: 'sts_rejected' });
  });

  it('refuses when AWS answers without naming the caller', async () => {
    await expect(
      verifierWith(stsResponder('<GetCallerIdentityResponse/>')).verify(attestation(), NONCE),
    ).rejects.toMatchObject({ reason: 'sts_unreadable' });
  });

  it('refuses, rather than accepting, when STS cannot be reached', async () => {
    const fetchImpl = (async () => {
      throw new Error('ENOTFOUND');
    }) as unknown as typeof fetch;

    await expect(verifierWith(fetchImpl).verify(attestation(), NONCE)).rejects.toMatchObject({
      reason: 'sts_unreachable',
    });
  });
});

describe('canonicalAwsSubject', () => {
  it('reduces an assumed-role ARN to the role that was assumed', () => {
    expect(canonicalAwsSubject('arn:aws:sts::237343248947:assumed-role/oxy-mention-task/1a2b3c')).toBe(
      'arn:aws:iam::237343248947:role/oxy-mention-task',
    );
  });

  it('keeps a partition that is not the commercial one', () => {
    expect(canonicalAwsSubject('arn:aws-us-gov:sts::111122223333:assumed-role/thing/session')).toBe(
      'arn:aws-us-gov:iam::111122223333:role/thing',
    );
  });

  it.each([
    ['a plain role ARN', 'arn:aws:iam::237343248947:role/oxy-mention-task'],
    ['a user ARN', 'arn:aws:iam::237343248947:user/PC-EXAMPLE'],
    ['something that is not an ARN at all', 'not-an-arn'],
  ])('leaves %s alone', (_label, value) => {
    expect(canonicalAwsSubject(value)).toBe(value);
  });
});

/**
 * The handle a minted token carries as `credentialId`, and the reason a
 * consumer may pin it.
 *
 * Homiio pins `payload.credentialId` and Clarity asserts exact claims; both
 * were held back from ADR 0026 on the belief that this value was
 * per-attestation and therefore unpinnable. It is not — it is a function of the
 * canonical subject and of nothing else — but nothing said so and nothing held
 * it, so the belief was reasonable. These cases are what makes it a property of
 * the code instead of a remark about it: anything that mixed a nonce, a clock,
 * a session name or a random byte into the handle reddens here rather than
 * silently breaking every consumer that pinned it.
 */
describe('workloadAttestationHandle', () => {
  it('is one value for every task of a role, whatever session presented it', () => {
    const handles = [
      'arn:aws:sts::237343248947:assumed-role/oxy-mention-task/f1e2d3c4b5a60718',
      'arn:aws:sts::237343248947:assumed-role/oxy-mention-task/0011223344556677',
      'arn:aws:sts::237343248947:assumed-role/oxy-mention-task/ecs-task-9988',
      // The operator-supplied form a binding stores, which must agree with the
      // per-task ones or an operator would be told a value the mint never emits.
      'arn:aws:iam::237343248947:role/oxy-mention-task',
    ].map((arn) => workloadAttestationHandle(canonicalAwsSubject(arn)));

    expect(new Set(handles).size).toBe(1);
  });

  it('is the same value on every call, with no clock or randomness in it', () => {
    const subject = canonicalAwsSubject(ARN);
    expect(workloadAttestationHandle(subject)).toBe(workloadAttestationHandle(subject));
  });

  it('is what the verifier actually puts in the token', async () => {
    // The one definition, reached from both sides. Two copies of this hash
    // would agree the day they were written and drift the first time either
    // moved, and the drift would surface as every pinning consumer rejecting
    // real traffic.
    const verified = await verifierWith(stsResponder(IDENTITY_XML)).verify(attestation(), NONCE);

    expect(verified.attestationId).toBe(workloadAttestationHandle(canonicalAwsSubject(ARN)));
  });

  it('tells an attested mint apart from a credential-minted one', () => {
    // Attribution, which the stable handle must not cost. A credential id is an
    // opaque application-credential id; `wl_` says "nothing here is revocable
    // by deleting a credential — delete the binding row".
    expect(workloadAttestationHandle(canonicalAwsSubject(ARN)).startsWith('wl_')).toBe(true);
  });

  it('does not carry the role name it names', () => {
    // One-way on purpose: the token travels to other services, and our own IAM
    // role names are not something it should spread around.
    expect(workloadAttestationHandle(canonicalAwsSubject(ARN))).not.toContain('oxy-mention-task');
  });
});
