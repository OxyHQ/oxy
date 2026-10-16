/**
 * Google Play Integrity, server side (ADR 0045).
 *
 * An Android app hands Oxy the integrity token Play issued for a challenge's
 * `requestHash`; Oxy asks Google to decode it (`decodeIntegrityToken`) and
 * judges the verdict itself. Google is reached with an OAuth access token Oxy
 * mints from the configured service account by the JWT-bearer grant
 * (RFC 7523), which is the whole of what a Google client library would do for
 * this one call — so no Google SDK is added for it.
 *
 * A verdict is accepted only when it names, all at once:
 * - the registered package, as both the requesting and the recognised package;
 * - `appRecognitionVerdict: PLAY_RECOGNIZED`, a genuine install from Play;
 * - at least one registered signing certificate digest;
 * - the challenge's `requestHash`, and a request time inside the challenge's life.
 *
 * Device integrity is not judged: ADR 0045's confinement is a product boundary,
 * and a person's own rooted phone gets nothing their session could not do.
 */

import { createSign } from 'node:crypto';
import type { PlayIntegrityConfig } from '../config/playIntegrity';
import { tracedFetch } from '../utils/tracedFetch';

const SCOPE = 'https://www.googleapis.com/auth/playintegrity';
const DECODE_URL = 'https://playintegrity.googleapis.com/v1';
const TIMEOUT_MS = 5_000;
const TOKEN_REFRESH_MARGIN_MS = 60_000;

export class PlayIntegrityUnavailableError extends Error {
  constructor(reason: string) {
    super(`Play Integrity is unavailable: ${reason}`);
    this.name = 'PlayIntegrityUnavailableError';
  }
}

/** Google refused to decode the token (HTTP 400): it is not a token for this package. */
export class PlayIntegrityTokenRejectedError extends Error {
  constructor() {
    super('Play Integrity refused the token');
    this.name = 'PlayIntegrityTokenRejectedError';
  }
}

/** The fields of a decoded verdict Oxy reads (`tokenPayloadExternal`). */
export interface PlayIntegrityVerdict {
  readonly requestDetails?: {
    readonly requestPackageName?: string;
    readonly requestHash?: string;
    readonly timestampMillis?: string;
  };
  readonly appIntegrity?: {
    readonly appRecognitionVerdict?: string;
    readonly packageName?: string;
    readonly certificateSha256Digest?: readonly string[];
  };
}

export type PlayIntegrityFailure =
  | 'package_mismatch'
  | 'not_play_recognized'
  | 'certificate_not_registered'
  | 'request_hash_mismatch'
  | 'stale';

export interface PlayIntegrityExpectation {
  readonly packageName: string;
  /** Lowercase hex SHA-256 digests. */
  readonly signingCertSha256: readonly string[];
  readonly requestHash: string;
  /** The challenge's life: the request must have been made inside it. */
  readonly notBefore: Date;
  readonly notAfter: Date;
}

const CLOCK_SKEW_MS = 30_000;

/** Judges a decoded verdict; `null` when it is accepted. */
export function judgePlayIntegrityVerdict(
  verdict: PlayIntegrityVerdict,
  expected: PlayIntegrityExpectation,
): PlayIntegrityFailure | null {
  const request = verdict.requestDetails;
  const app = verdict.appIntegrity;
  if (
    request?.requestPackageName !== expected.packageName ||
    app?.packageName !== expected.packageName
  ) {
    return 'package_mismatch';
  }
  if (app.appRecognitionVerdict !== 'PLAY_RECOGNIZED') return 'not_play_recognized';
  // Google reports each digest as unpadded base64url.
  const digests = (app.certificateSha256Digest ?? []).map((digest) =>
    Buffer.from(digest, 'base64url').toString('hex'),
  );
  if (!digests.some((digest) => expected.signingCertSha256.includes(digest))) {
    return 'certificate_not_registered';
  }
  if (request.requestHash !== expected.requestHash) return 'request_hash_mismatch';
  const at = Number(request.timestampMillis);
  if (
    !Number.isFinite(at) ||
    at < expected.notBefore.getTime() - CLOCK_SKEW_MS ||
    at > expected.notAfter.getTime() + CLOCK_SKEW_MS
  ) {
    return 'stale';
  }
  return null;
}

export interface PlayIntegrityClient {
  decode(packageName: string, integrityToken: string): Promise<PlayIntegrityVerdict>;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** A Play Integrity client for one configuration, caching its access token until shortly before expiry. */
export function createPlayIntegrityClient(
  config: PlayIntegrityConfig,
  options: { fetch?: FetchLike; now?: () => number } = {},
): PlayIntegrityClient {
  const fetchImpl: FetchLike = options.fetch ?? tracedFetch;
  const now = options.now ?? Date.now;
  let token: { value: string; expiresAt: number } | undefined;

  const call = async (
    url: string,
    init: RequestInit,
    badRequestIsRefusal = false,
  ): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new PlayIntegrityUnavailableError(error instanceof Error ? error.name : 'network');
    }
    if (badRequestIsRefusal && response.status === 400) throw new PlayIntegrityTokenRejectedError();
    if (!response.ok) throw new PlayIntegrityUnavailableError(`HTTP ${response.status}`);
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new PlayIntegrityUnavailableError('malformed answer');
    }
  };

  const accessToken = async (): Promise<string> => {
    if (token && token.expiresAt - TOKEN_REFRESH_MARGIN_MS > now()) return token.value;
    const issuedAt = Math.floor(now() / 1000);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = `${encode({ alg: 'RS256', typ: 'JWT', kid: config.privateKeyId })}.${encode({
      iss: config.clientEmail,
      scope: SCOPE,
      aud: config.tokenUri,
      iat: issuedAt,
      exp: issuedAt + 3600,
    })}`;
    const signature = createSign('RSA-SHA256').update(input).sign(config.privateKey, 'base64url');
    const answer = (await call(config.tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${input}.${signature}`,
      }).toString(),
    })) as { access_token?: unknown; expires_in?: unknown };
    if (typeof answer.access_token !== 'string' || typeof answer.expires_in !== 'number') {
      throw new PlayIntegrityUnavailableError('no access token');
    }
    token = { value: answer.access_token, expiresAt: now() + answer.expires_in * 1000 };
    return token.value;
  };

  return {
    async decode(packageName, integrityToken) {
      const answer = (await call(
        `${DECODE_URL}/${encodeURIComponent(packageName)}:decodeIntegrityToken`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${await accessToken()}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ integrityToken }),
        },
        true,
      )) as { tokenPayloadExternal?: unknown };
      const payload = answer.tokenPayloadExternal;
      if (typeof payload !== 'object' || payload === null) {
        throw new PlayIntegrityUnavailableError('no verdict');
      }
      return payload as PlayIntegrityVerdict;
    },
  };
}
