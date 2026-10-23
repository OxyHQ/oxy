import { createHash, createHmac } from 'node:crypto';
import { trimTrailingSlashes } from '../utils/slashes';
import { awaitRequestSignal } from '../utils/requestSignal';

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
  /** Temporary infrastructure credentials, for example an assumed development role. */
  credentials?: WorkloadCredentialProvider;
  /** Oxy's base URL, e.g. `https://api.oxy.so`. */
  baseUrl: string;
  /**
   * The resource server the token is for (e.g. `kaana.ai`). Omitted, Oxy mints
   * for `oxy-api`, as it always has.
   */
  audience?: string;
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
export interface WorkloadCredentials {
  AccessKeyId: string;
  SecretAccessKey: string;
  Token?: string;
}

export type WorkloadCredentialProvider = () => Promise<WorkloadCredentials>;

/**
 * Whether the default ECS credential source is available.
 *
 * This does not inspect an explicitly configured workload provider. Local
 * development can use temporary IAM role credentials through the optional
 * @oxy.so/core/server/aws provider and a registered development binding.
 */
export function canAttestWorkloadIdentity(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || env.AWS_CONTAINER_CREDENTIALS_FULL_URI,
  );
}

async function containerCredentials(fetchImpl: typeof fetch): Promise<WorkloadCredentials> {
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
  const credentials = (await response.json()) as WorkloadCredentials;
  if (!credentials.AccessKeyId || !credentials.SecretAccessKey) {
    throw new Error('The container credentials endpoint answered without credentials.');
  }
  return credentials;
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Signs `GetCallerIdentity` with SigV4, binding the nonce into the signature.
 *
 * `SignedHeaders` includes the nonce header deliberately: Oxy refuses an
 * attestation whose signature does not cover it, because a nonce the signature
 * does not cover can be swapped by whoever captured the attestation.
 */
function signGetCallerIdentity(
  credentials: WorkloadCredentials,
  nonce: string,
  now: Date,
): Record<string, string> {
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
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
    sha256Hex(STS_BODY),
  ].join('\n');

  const scope = `${dateStamp}/${STS_REGION}/sts/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${credentials.SecretAccessKey}`, dateStamp), STS_REGION), 'sts'),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  return {
    ...headers,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${credentials.AccessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** The AWS attestation: signed headers, and nothing else. */
async function awsContainerAttestation(
  fetchImpl: typeof fetch,
  nonce: string,
): Promise<{ headers: Record<string, string> }> {
  const credentials = await containerCredentials(fetchImpl);
  return { headers: signGetCallerIdentity(credentials, nonce, new Date()) };
}

/** A proof of this process's identity, exactly as `POST /auth/service-token/workload` takes it. */
export interface WorkloadAttestation {
  provider: 'aws-iam';
  attestation: { headers: Record<string, string> };
}

/**
 * Signs this process's identity proof over a nonce the CALLER chose, and sends
 * it nowhere.
 *
 * {@link requestWorkloadServiceToken} is the ordinary consumer: Oxy issues the
 * nonce and replays the proof. This exists for the one host that is its own
 * verifier — Oxy's API acting as an application it hosts (Inbox) needs to learn
 * which role it runs as, and the honest way to learn that is the way it learns
 * anyone else's: sign `GetCallerIdentity` and let STS say whose signature it is.
 * Reading a role name out of configuration would be the process's own word for
 * what it is, which is what ADR 0026 refuses from every other caller.
 *
 * The same signer, so the two can never disagree about the shape the verifier
 * accepts. Throws exactly as the token path does when there is no identity here.
 */
export async function attestWorkloadIdentity(options: {
  nonce: string;
  fetch?: typeof fetch;
}): Promise<WorkloadAttestation> {
  if (!options.nonce) throw new Error('A workload attestation needs a nonce to sign.');
  return {
    provider: 'aws-iam',
    attestation: await awsContainerAttestation(options.fetch ?? fetch, options.nonce),
  };
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
  return exchangeWorkloadServiceToken(options, 2);
}

/** @internal Finite reader-first rollout bridge; not exported by the package. */
export function requestLegacyWorkloadServiceToken(options: WorkloadServiceTokenOptions) {
  return exchangeWorkloadServiceToken(options, 1);
}

async function exchangeWorkloadServiceToken(
  options: WorkloadServiceTokenOptions,
  protocolVersion: 1 | 2,
): Promise<WorkloadServiceToken> {
  if ('scopes' in options) throw new Error('First-party workloads do not request scopes');
  // Bound the shared exchange independently of any one consumer's deadline.
  // A cancelled consumer must not cancel another caller's in-flight mint.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  const fetchImpl = options.fetch ?? fetch;
  const boundedFetch: typeof fetch = (input, init) => {
    if (controller.signal.aborted) return Promise.reject(new Error('Workload exchange timed out'));
    return fetchImpl(input, {
      ...init,
      signal: controller.signal,
      redirect: 'error',
      credentials: 'omit',
    });
  };
  try {
    return await awaitRequestSignal(
      completeWorkloadExchange(options, protocolVersion, boundedFetch),
      controller.signal,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function completeWorkloadExchange(
  options: WorkloadServiceTokenOptions,
  protocolVersion: 1 | 2,
  fetchImpl: typeof fetch,
): Promise<WorkloadServiceToken> {
  const base = trimTrailingSlashes(options.baseUrl);

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

  const attestation = options.credentials
    ? { headers: signGetCallerIdentity(await options.credentials(), challenge.nonce, new Date()) }
    : await awsContainerAttestation(fetchImpl, challenge.nonce);

  const tokenResponse = await fetchImpl(`${base}/auth/service-token/workload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'aws-iam',
      ...(protocolVersion === 2 ? { protocolVersion: 2 } : {}),
      nonce: challenge.nonce,
      attestation,
      ...(options.audience === undefined ? {} : { audience: options.audience }),
    }),
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
