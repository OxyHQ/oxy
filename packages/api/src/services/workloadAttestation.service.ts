import crypto from 'node:crypto';

import { logger } from '../utils/logger';

/**
 * Workload attestation: how a first-party service proves what it IS, with no
 * secret anybody had to create, copy or rotate.
 *
 * ## The problem this exists to remove
 *
 * Every official Oxy service that calls another one holds an
 * `ApplicationCredential` — an api key and secret a human issued in the console
 * and pasted into a parameter store. That pair is doing two jobs: it opens the
 * door AND it says who is knocking. The second job is the one that matters, and
 * a long-lived shared secret is a poor way to do it: it is created by hand, it
 * lives in two places at once, it is rotated by remembering to, and every copy
 * is a place it can leak from.
 *
 * A workload already has an identity its own infrastructure issues and rotates:
 * an IAM role on AWS, a service account on Kubernetes, a managed identity on
 * Azure, a machine certificate on hardware you own. This module turns a PROOF of
 * that identity into the very same Oxy service token `POST /auth/service-token`
 * mints from a credential — so nothing downstream changes, and no first-party
 * service needs a credential at all.
 *
 * Third-party applications keep the credential path. That is not an oversight:
 * a third party has no identity in our infrastructure to attest to, and asking
 * them to register is exactly where registration belongs.
 *
 * ## Portability is the point, so the provider is behind an interface
 *
 * Nothing above this module may learn that we run on AWS. `AttestationVerifier`
 * is the whole seam: one implementation per place a workload can run, resolving
 * to a provider-scoped subject string. Moving to another cloud — or to our own
 * hardware — means writing one more verifier here, not touching a single caller
 * or a single consumer of the token.
 *
 * ## Why a signed STS call rather than an identity document
 *
 * AWS hands an ECS task rotating credentials, not a signed statement of who it
 * is. The portable trick (the one HashiCorp Vault's IAM auth uses) is to make
 * the caller SIGN a `GetCallerIdentity` request it never sends, and send us the
 * signed request instead. We replay it to STS, which answers with the identity
 * of whoever signed it. We therefore never see a secret, and we learn the caller
 * from AWS rather than from the caller.
 *
 * Two things make that safe, and both are enforced below:
 *
 *   * **The request is pinned to STS.** A signed request is an arbitrary HTTP
 *     request that this service would otherwise make on the caller's word —
 *     which is a server-side request forgery with extra steps. Only an exact
 *     STS host and an exact `GetCallerIdentity` body are replayed.
 *   * **The signature is bound to a nonce we issued and to a moment.** Without
 *     that, one captured attestation is a permanent impersonation of the
 *     workload it came from. The nonce must be inside the SIGNED headers, so a
 *     replay against a different nonce cannot be re-signed by anyone but the
 *     workload itself.
 */

/** Where a workload can run. One verifier per value; the vocabulary is closed. */
export const ATTESTATION_PROVIDERS = ['aws-iam'] as const;
export type AttestationProvider = (typeof ATTESTATION_PROVIDERS)[number];

/** What an attestation resolves to: a stable, provider-scoped identity string. */
export interface AttestedWorkload {
  provider: AttestationProvider;
  /**
   * The identity the provider vouched for, verbatim — an IAM role ARN, a
   * Kubernetes service-account URI, a certificate subject. Never parsed for
   * meaning here; mapping it to an application is the caller's job.
   */
  subject: string;
  /**
   * A short, stable, non-secret handle for the attestation itself, so a minted
   * token can be attributed to the workload that asked for it without carrying
   * the subject (which can be long and names our infrastructure).
   */
  attestationId: string;
}

export class AttestationError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = 'AttestationError';
    this.reason = reason;
  }
}

export interface AttestationVerifier {
  readonly provider: AttestationProvider;
  verify(payload: unknown, expectedNonce: string): Promise<AttestedWorkload>;
}

/* ------------------------------------------------------------------ */
/* AWS IAM                                                            */
/* ------------------------------------------------------------------ */

/** The only body that may be replayed, byte for byte. */
const STS_BODY = 'Action=GetCallerIdentity&Version=2011-06-15';

/**
 * The hosts an attestation may be replayed to.
 *
 * Global plus the regional endpoints, matched exactly rather than by suffix: a
 * suffix test accepts `sts.amazonaws.com.attacker.example`, which is the classic
 * way this check is got wrong.
 */
const STS_HOST_PATTERN = /^sts(\.[a-z0-9-]+)?\.amazonaws\.com$/;

/** How old a signed request may be. AWS's own signature window is 15 minutes. */
const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;

/** The header the nonce travels in. It MUST appear in the signature's SignedHeaders. */
export const ATTESTATION_NONCE_HEADER = 'x-oxy-attestation-nonce';

interface SignedRequest {
  headers: Record<string, string>;
}

function headerOf(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

/** `20260918T041500Z` → epoch ms, or `null` when it is not that shape. */
function parseAmzDate(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  return Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
}

/**
 * Verifies a signed `GetCallerIdentity` request by replaying it to STS.
 *
 * The caller signs with the credentials its platform gave it and sends the
 * signature; we send that signature to AWS and believe AWS's answer, not the
 * caller's. Anything that is not an STS `GetCallerIdentity` carrying our nonce
 * inside its signature is refused before a single byte leaves this process.
 */
export class AwsIamAttestationVerifier implements AttestationVerifier {
  readonly provider = 'aws-iam' as const;

  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(options: { fetch?: typeof fetch; now?: () => number } = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async verify(payload: unknown, expectedNonce: string): Promise<AttestedWorkload> {
    const request = this.parse(payload);
    const host = headerOf(request.headers, 'host');
    if (!host || !STS_HOST_PATTERN.test(host)) {
      throw new AttestationError('host_not_sts', 'The attestation is not addressed to AWS STS.');
    }

    const authorization = headerOf(request.headers, 'authorization');
    if (!authorization || !authorization.startsWith('AWS4-HMAC-SHA256 ')) {
      throw new AttestationError('unsigned', 'The attestation carries no SigV4 signature.');
    }

    /**
     * The nonce must be SIGNED, not merely present. A nonce the signature does
     * not cover can be swapped by whoever captured the attestation, which is the
     * entire replay this check exists to stop.
     */
    const signedHeaders = /SignedHeaders=([^,]+)/.exec(authorization)?.[1] ?? '';
    if (!signedHeaders.split(';').includes(ATTESTATION_NONCE_HEADER)) {
      throw new AttestationError('nonce_unsigned', 'The attestation does not sign the nonce header.');
    }
    const nonce = headerOf(request.headers, ATTESTATION_NONCE_HEADER);
    if (!nonce || !timingSafeEquals(nonce, expectedNonce)) {
      throw new AttestationError('nonce_mismatch', 'The attestation answers a different challenge.');
    }

    const signedAt = parseAmzDate(headerOf(request.headers, 'x-amz-date'));
    if (signedAt === null || Math.abs(this.now() - signedAt) > MAX_SIGNATURE_AGE_MS) {
      throw new AttestationError('stale', 'The attestation was signed too long ago.');
    }

    const identity = await this.callSts(host, request.headers);
    return {
      provider: this.provider,
      subject: identity,
      attestationId: `wl_${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 24)}`,
    };
  }

  /** Shape-checks the caller's payload before anything is believed about it. */
  private parse(payload: unknown): SignedRequest {
    if (typeof payload !== 'object' || payload === null) {
      throw new AttestationError('malformed', 'The attestation is not an object.');
    }
    const headers = (payload as { headers?: unknown }).headers;
    if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
      throw new AttestationError('malformed', 'The attestation carries no headers.');
    }
    const flat: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      if (typeof value !== 'string') {
        throw new AttestationError('malformed', 'An attestation header is not a string.');
      }
      flat[key] = value;
    }
    return { headers: flat };
  }

  /**
   * Replays the signed request and returns the ARN STS attributes it to.
   *
   * The method, path and body are OURS, not the caller's: only the headers —
   * which is where the signature lives — come from the attestation. So the most
   * a malicious payload can do is fail to verify against a request it did not
   * sign.
   */
  private async callSts(host: string, headers: Record<string, string>): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchImpl(`https://${host}/`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
        body: STS_BODY,
      });
    } catch (error: unknown) {
      logger.warn('[WorkloadAttestation] STS unreachable', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
      throw new AttestationError('sts_unreachable', 'The attestation could not be verified right now.');
    }

    const body = await response.text();
    if (!response.ok) {
      // STS says why in an XML error; the reason is bounded and safe to log, the
      // body is not (it echoes request metadata).
      logger.warn('[WorkloadAttestation] STS refused the attestation', { status: response.status });
      throw new AttestationError('sts_rejected', 'The attestation was refused by AWS.');
    }

    const arn = /<Arn>([^<]+)<\/Arn>/.exec(body)?.[1];
    if (!arn) {
      throw new AttestationError('sts_unreadable', 'AWS did not name the caller.');
    }
    return arn;
  }
}

function timingSafeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

const verifiers = new Map<AttestationProvider, AttestationVerifier>([
  ['aws-iam', new AwsIamAttestationVerifier()],
]);

/** Test seam: swap a verifier for one that does not call AWS. */
export function registerAttestationVerifier(verifier: AttestationVerifier): void {
  verifiers.set(verifier.provider, verifier);
}

export function isAttestationProvider(value: unknown): value is AttestationProvider {
  return typeof value === 'string' && (ATTESTATION_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Verifies an attestation with the verifier for its provider.
 *
 * A provider with no verifier is refused rather than trusted — the failure mode
 * of "we do not know how to check this" must never be "then it is fine".
 */
export async function verifyWorkloadAttestation(
  provider: AttestationProvider,
  payload: unknown,
  expectedNonce: string,
): Promise<AttestedWorkload> {
  const verifier = verifiers.get(provider);
  if (!verifier) {
    throw new AttestationError('unsupported_provider', 'That attestation provider is not supported here.');
  }
  return verifier.verify(payload, expectedNonce);
}
