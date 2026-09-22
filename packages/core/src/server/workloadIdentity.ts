import { loadNodeCrypto } from '@oxy.so/protocol';

/** Just the two primitives this module signs with. */
type NodeCryptoSubset = Pick<Awaited<ReturnType<typeof loadNodeCrypto>>, 'createHash' | 'createHmac'>;

/**
 * Asking Oxy for a service token by proving what this process IS (ADR 0026).
 *
 * The other half of the credential-free path: `packages/api` verifies the proof,
 * this builds one. A first-party service that calls
 * {@link requestWorkloadServiceToken} needs no api key, no secret and no entry in
 * a parameter store — only to be running as itself.
 *
 * ## Why this signs SigV4 by hand
 *
 * The attestation is a signed `GetCallerIdentity` request that is never sent to
 * AWS by us; Oxy replays it. Producing one needs credentials and a signature,
 * and the obvious way to get both is the AWS SDK — which this package must not
 * depend on. `@oxy.so/core` ships to React Native and Expo, where several
 * megabytes of AWS client for a call that only ever happens on a server is not a
 * trade worth making, and the package rules keep optional heavyweights out of
 * the root barrel for exactly this reason.
 *
 * So: credentials come from the container credentials endpoint ECS already
 * exposes to every task, and the signature is ~40 lines of HMAC out of
 * `node:crypto`. No dependency, and nothing here is AWS-specific above
 * {@link awsContainerAttestation} — a second provider is another function with
 * the same shape.
 *
 * ## What this never does
 *
 * It never sends the signed request to AWS. It never logs a credential, a
 * signature or a token. It caches the TOKEN (short-lived, from Oxy) and never
 * the AWS credentials, which the endpoint hands out fresh anyway.
 */

/** The header Oxy's verifier requires inside the signature. Must match `ATTESTATION_NONCE_HEADER`. */
const NONCE_HEADER = 'x-oxy-attestation-nonce';
const STS_HOST = 'sts.amazonaws.com';
const STS_REGION = 'us-east-1';
const STS_BODY = 'Action=GetCallerIdentity&Version=2011-06-15';

export interface WorkloadServiceTokenOptions {
  /** Oxy's base URL, e.g. `https://api.oxy.so`. */
  baseUrl: string;
  /** Injected in tests; defaults to the global. */
  fetch?: typeof fetch;
}

export interface WorkloadServiceToken {
  token: string;
  /** Seconds from now, as Oxy reported it. */
  expiresIn: number;
  appName: string;
}

/** Credentials as the ECS container credentials endpoint returns them. */
interface ContainerCredentials {
  AccessKeyId: string;
  SecretAccessKey: string;
  Token?: string;
}

/**
 * Whether this process can attest at all.
 *
 * The relative URI is set by ECS on every task and by nothing else, so its
 * presence is the honest test for "we can prove what we are here". A local
 * checkout has no attestation to offer and must fall back to a credential.
 */
export function canAttestWorkloadIdentity(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || env.AWS_CONTAINER_CREDENTIALS_FULL_URI);
}

async function containerCredentials(fetchImpl: typeof fetch): Promise<ContainerCredentials> {
  const relative = process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
  const url = relative
    ? `http://169.254.170.2${relative}`
    : (process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI as string);
  if (!url) {
    throw new Error('No container credentials endpoint: this process cannot attest its identity.');
  }
  const response = await fetchImpl(url, {
    headers: process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN
      ? { authorization: process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN }
      : {},
  });
  if (!response.ok) {
    throw new Error(`The container credentials endpoint answered ${response.status}.`);
  }
  const credentials = (await response.json()) as ContainerCredentials;
  if (!credentials.AccessKeyId || !credentials.SecretAccessKey) {
    throw new Error('The container credentials endpoint answered without credentials.');
  }
  return credentials;
}

function hmac(crypto: NodeCryptoSubset, key: Buffer | string, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(crypto: NodeCryptoSubset, value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Signs `GetCallerIdentity` with SigV4, binding the nonce into the signature.
 *
 * `SignedHeaders` includes the nonce header deliberately: Oxy refuses an
 * attestation whose signature does not cover it, because a nonce the signature
 * does not cover can be swapped by whoever captured the attestation.
 */
function signGetCallerIdentity(crypto: NodeCryptoSubset, credentials: ContainerCredentials, nonce: string, now: Date): Record<string, string> {
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);

  const headers: Record<string, string> = {
    host: STS_HOST,
    'x-amz-date': amzDate,
    [NONCE_HEADER]: nonce,
  };
  if (credentials.Token) headers['x-amz-security-token'] = credentials.Token;

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headers[name]}\n`).join('');
  const signedHeaders = signedHeaderNames.join(';');

  const canonicalRequest = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    signedHeaders,
    sha256Hex(crypto, STS_BODY),
  ].join('\n');

  const scope = `${dateStamp}/${STS_REGION}/sts/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(crypto, canonicalRequest)].join('\n');

  const signingKey = hmac(
    crypto,
    hmac(crypto, hmac(crypto, hmac(crypto, `AWS4${credentials.SecretAccessKey}`, dateStamp), STS_REGION), 'sts'),
    'aws4_request',
  );
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  return {
    ...headers,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${credentials.AccessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** The AWS attestation: signed headers, and nothing else. */
async function awsContainerAttestation(fetchImpl: typeof fetch, nonce: string): Promise<{ headers: Record<string, string> }> {
  // `loadNodeCrypto()` rather than a static `import ... from 'node:crypto'`.
  //
  // This module is reachable from the ROOT barrel — `mixins/OxyServices.auth`
  // loads it to decide whether this process can attest — and a static
  // `node:crypto` there stopped every React Native consumer bundling at all.
  // Measured with `expo export --platform ios` on `packages/commons`: `Unable
  // to resolve module node:crypto`, through `server/workloadIdentity.js` ->
  // `mixins/OxyServices.auth.js` -> `index.js`, so importing one error class
  // from the barrel was enough. Metro resolves the target of a literal
  // `import()` at BUILD time, so the `await import(...)` at the call site
  // deferred execution and nothing else.
  //
  // Neither a `.native` sibling nor a `"react-native"` package map fixes it
  // HERE: the built ESM carries the explicit `.js` extension Node's resolver
  // needs (`scripts/fix-esm-imports.mjs`), and Metro appends its platform
  // suffixes to the whole specifier, looking for
  // `workloadIdentity.js.native.js`. `@oxy.so/protocol`'s `loadNodeCrypto` is
  // the primitive this package already reaches for in `keyManager` and
  // `signatureService`, and it is platform-split at its own source, so this
  // file simply stops naming `node:crypto`.
  const crypto = await loadNodeCrypto();
  const credentials = await containerCredentials(fetchImpl);
  return { headers: signGetCallerIdentity(crypto, credentials, nonce, new Date()) };
}

/**
 * Exchanges this process's identity for an Oxy service token.
 *
 * Two round trips by design (see ADR 0026): a nonce, then an attestation that
 * signs it. The caller caches the token — it lives an hour — rather than doing
 * this per request.
 *
 * Failures are thrown, never swallowed into an empty token: a caller that
 * cannot prove what it is must not go on to make an unauthenticated request and
 * discover the problem as a 401 somewhere else.
 */
export async function requestWorkloadServiceToken(
  options: WorkloadServiceTokenOptions,
): Promise<WorkloadServiceToken> {
  const fetchImpl = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, '');

  const challengeResponse = await fetchImpl(`${base}/auth/service-token/workload/challenge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  if (!challengeResponse.ok) {
    throw new Error(`Oxy refused to issue a workload challenge (${challengeResponse.status}).`);
  }
  const challenge = unwrap<{ nonce?: string }>(await challengeResponse.json());
  if (!challenge?.nonce) {
    throw new Error('Oxy issued a workload challenge with no nonce.');
  }

  const attestation = await awsContainerAttestation(fetchImpl, challenge.nonce);

  const tokenResponse = await fetchImpl(`${base}/auth/service-token/workload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'aws-iam', nonce: challenge.nonce, attestation }),
  });
  if (!tokenResponse.ok) {
    // The body carries a bounded `reason`; the token never travels on a failure,
    // so there is nothing here that must not be seen.
    throw new Error(`Oxy refused the workload attestation (${tokenResponse.status}).`);
  }
  const granted = unwrap<Partial<WorkloadServiceToken>>(await tokenResponse.json());
  if (!granted?.token || typeof granted.expiresIn !== 'number') {
    throw new Error('Oxy answered the attestation without a usable token.');
  }
  return { token: granted.token, expiresIn: granted.expiresIn, appName: granted.appName ?? '' };
}

/** Oxy wraps successful bodies in `{ data }`; older routes answer flat. */
function unwrap<T>(body: unknown): T | null {
  if (typeof body !== 'object' || body === null) return null;
  const envelope = body as { data?: unknown };
  return (typeof envelope.data === 'object' && envelope.data !== null ? envelope.data : body) as T;
}
