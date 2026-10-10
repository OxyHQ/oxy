/**
 * HTTP Signatures (draft-cavage-http-signatures-12) — the PURE sign/verify
 * crypto that every Oxy app's ActivityPub federation shares.
 *
 * This is the highest-risk surface in the federation engine: the exact bytes of
 * the signing string, the covered-header list and its order, the signature
 * parameters, and the `X-Forwarded-Host` host reconstruction are what remote
 * servers (Mastodon et al.) verify against. A one-character drift silently kills
 * ALL federation, so this module is a byte-for-byte extraction of Mention's
 * proven implementation — with the ONLY behavioural knobs made explicit:
 *
 *  - **private-key custody is injected** ({@link HttpSignatureSigner}). The
 *    private key NEVER enters this package; the app supplies a `sign(keyId,
 *    signingString)` that (for Mention) calls oxy-api `POST /federation/sign`.
 *  - **`X-Forwarded-Host` trust is opt-in** ({@link VerifyHttpSignatureOptions.trustForwardedHost}).
 *    Mention runs behind a CF-proxied apex that rewrites the origin `Host`, so it
 *    passes `true`; a directly-exposed origin leaves it `false`.
 *
 * Lives in the isomorphic `.` entry (no Express / database driver): it depends only on
 * the runtime `crypto` builtin (Node / Bun) and is never invoked from browser /
 * React-Native bundles — RN consumers import only the connector TYPES, which are
 * erased at compile time.
 */

import crypto from 'node:crypto';

/** The signature algorithm parameter emitted in (and expected on) the `Signature` header. */
export const HTTP_SIGNATURE_ALGORITHM = 'rsa-sha256';

/**
 * The default content-type folded into the signing string for body-bearing
 * requests. ActivityPub delivery signs `content-type` (some servers — e.g.
 * Threads — require it), and the AP content type is always
 * `application/activity+json`.
 */
export const DEFAULT_SIGNED_CONTENT_TYPE = 'application/activity+json';

/**
 * Signs an already-composed signing string with the private key backing `keyId`
 * and returns the base64 RSA-SHA256 signature. The private key custody lives
 * behind this function — for Mention it delegates to oxy-api's
 * `POST /federation/sign` so the key never leaves Oxy.
 */
export type HttpSignatureSigner = (keyId: string, signingString: string) => Promise<string>;

/** Options controlling the signing-string composition (all optional). */
export interface SignRequestOptions {
  /**
   * The content-type value included in the signing string (and covered by the
   * signature) for body-bearing requests. Defaults to
   * {@link DEFAULT_SIGNED_CONTENT_TYPE}. The Content-Type request HEADER itself is
   * set by the deliverer's fetch, not returned here.
   */
  contentType?: string;
}

/**
 * Build the HTTP Signature header per draft-cavage-http-signatures-12 and sign it
 * via the injected {@link HttpSignatureSigner} (the private key never enters this
 * package).
 *
 * The spec-correct signing string is composed locally: `(request-target)`, host,
 * date, and — for body-bearing requests — digest and content-type. The composed
 * string is handed to `sign`, and the resulting signature is assembled into the
 * `Signature:` header.
 *
 * Returns the headers to attach to the outbound request (Host, Date, optional
 * Digest, and Signature). Content-Type is set by the deliverer's fetch.
 */
export async function signRequest(
  sign: HttpSignatureSigner,
  keyId: string,
  method: string,
  url: string,
  body?: string,
  options: SignRequestOptions = {},
): Promise<Record<string, string>> {
  const contentType = options.contentType ?? DEFAULT_SIGNED_CONTENT_TYPE;
  const parsedUrl = new URL(url);
  const date = new Date().toUTCString();
  const headers: Record<string, string> = {
    Host: parsedUrl.host,
    Date: date,
  };

  const signedHeaderNames = ['(request-target)', 'host', 'date'];
  const signingParts = [
    `(request-target): ${method.toLowerCase()} ${parsedUrl.pathname}${parsedUrl.search}`,
    `host: ${parsedUrl.host}`,
    `date: ${date}`,
  ];

  if (body) {
    const digest = crypto.createHash('sha256').update(body).digest('base64');
    headers.Digest = `SHA-256=${digest}`;
    signedHeaderNames.push('digest');
    signingParts.push(`digest: SHA-256=${digest}`);
    // Include content-type in signature (required by some servers like Threads)
    signedHeaderNames.push('content-type');
    signingParts.push(`content-type: ${contentType}`);
  }

  const signingString = signingParts.join('\n');
  const signature = await sign(keyId, signingString);

  headers.Signature = [
    `keyId="${keyId}"`,
    `algorithm="${HTTP_SIGNATURE_ALGORITHM}"`,
    `headers="${signedHeaderNames.join(' ')}"`,
    `signature="${signature}"`,
  ].join(',');

  return headers;
}

/**
 * Parse the Signature header from an incoming request.
 */
function parseSignatureHeader(signatureHeader: string): {
  keyId: string;
  algorithm: string;
  headers: string[];
  signature: string;
} | null {
  const params: Record<string, string> = {};
  const regex = /(\w+)="([^"]*)"/g;
  let match = regex.exec(signatureHeader);
  while (match !== null) {
    params[match[1]] = match[2];
    match = regex.exec(signatureHeader);
  }

  if (!params.keyId || !params.signature) return null;

  return {
    keyId: params.keyId,
    algorithm: params.algorithm || HTTP_SIGNATURE_ALGORITHM,
    headers: (params.headers || 'date').split(' '),
    signature: params.signature,
  };
}

/** An inbound request reduced to what signature verification needs. */
export interface VerifyHttpRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

/** The verdict of {@link verifyHttpSignature}. */
export interface VerifyHttpResult {
  verified: boolean;
  actorUri?: string;
  reason?: string;
}

/**
 * Resolve a `keyId` to its public key PEM and the actor URI that owns it, or
 * `null` when the key cannot be fetched (a failed fetch fails verification).
 */
export type FetchPublicKey = (
  keyId: string,
) => Promise<{ publicKeyPem: string; actorUri: string } | null>;

/** Options controlling inbound signature verification. */
export interface VerifyHttpSignatureOptions {
  /**
   * When `true`, reconstruct the signed `host` line from `X-Forwarded-Host`
   * (first comma token) instead of `Host` when the header is present.
   *
   * Load-bearing for an edge-proxied apex: when a CDN/edge rewrites the origin
   * `Host` (e.g. `mention.earth` → `api.mention.earth`) and forwards the ORIGINAL
   * signed host in `X-Forwarded-Host`, the verifier must rebuild the `host`
   * signing line from it or the reconstructed string never matches what the
   * sender signed. A proxy chain may append a comma-separated list whose FIRST
   * token is the client-facing host. This grants a forger nothing: the signature
   * cryptographically binds whatever host value the sender signed, so a bogus
   * `X-Forwarded-Host` simply fails verification. Falls back to `host` when the
   * header is absent (direct delivery). Defaults to `false` (trust only `Host`).
   */
  trustForwardedHost?: boolean;
  /**
   * Optional sink for non-fatal diagnostics (key-fetch failure, verify
   * exception). No-op when omitted. Kept out of the return value so verdicts
   * stay data-only.
   */
  onDebug?: (message: string, detail?: unknown) => void;
}

/**
 * Verify the HTTP signature on an incoming request.
 * Returns the actor URI (key owner) if valid, null otherwise.
 */
export async function verifyHttpSignature(
  req: VerifyHttpRequest,
  fetchPublicKey: FetchPublicKey,
  options: VerifyHttpSignatureOptions = {},
): Promise<VerifyHttpResult> {
  const signatureHeader = req.headers.signature as string | undefined;
  if (!signatureHeader) return { verified: false, reason: 'missing-signature' };

  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) return { verified: false, reason: 'invalid-signature-header' };

  const keyData = await fetchPublicKey(parsed.keyId);
  if (!keyData) {
    options.onDebug?.(`Failed to fetch public key for keyId: ${parsed.keyId}`);
    return { verified: false, reason: 'key-fetch-failed' };
  }

  const lowerHeaders = Object.fromEntries(
    Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]),
  );

  // Enforce Date skew (+/- 10 minutes) if present
  const dateHeader = lowerHeaders.date;
  if (dateHeader) {
    const dateVal = Array.isArray(dateHeader) ? dateHeader[0] : dateHeader;
    const parsedDate = Date.parse(dateVal || '');
    if (!Number.isNaN(parsedDate)) {
      const skew = Math.abs(Date.now() - parsedDate);
      if (skew > 10 * 60 * 1000) {
        return { verified: false, reason: 'date-skew' };
      }
    }
  }

  // If Digest header is required in signature but missing/invalid, fail early
  if (parsed.headers.includes('digest')) {
    const digestHeader = lowerHeaders.digest;
    const bodyString =
      typeof req.body === 'string' ? req.body : req.body ? JSON.stringify(req.body) : '';
    if (!digestHeader) {
      return { verified: false, reason: 'missing-digest' };
    }
    const expectedDigest = `SHA-256=${crypto.createHash('sha256').update(bodyString).digest('base64')}`;
    const digestVal = Array.isArray(digestHeader) ? digestHeader[0] : digestHeader;
    if (digestVal !== expectedDigest) {
      return { verified: false, reason: 'digest-mismatch' };
    }
  }

  const signingParts = parsed.headers.map((header) => {
    const name = header.toLowerCase();
    if (name === '(request-target)') {
      return `(request-target): ${req.method.toLowerCase()} ${req.path}`;
    }
    // Reconstruct the `host` line from `x-forwarded-host` when the caller trusts
    // it (an edge that rewrites the origin Host forwards the ORIGINAL signed host
    // here; a proxy chain's FIRST comma token is the client-facing host). See
    // VerifyHttpSignatureOptions.trustForwardedHost. Falls back to `host` when the
    // header is absent (direct delivery), preserving direct-delivery behavior.
    if (name === 'host' && options.trustForwardedHost) {
      const forwarded = lowerHeaders['x-forwarded-host'];
      const forwardedValue = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      const firstToken = forwardedValue?.split(',')[0]?.trim();
      if (firstToken) {
        return `host: ${firstToken}`;
      }
    }
    const value = lowerHeaders[name];
    return `${name}: ${Array.isArray(value) ? value[0] : value}`;
  });

  const signingString = signingParts.join('\n');
  const verifier = crypto.createVerify('sha256');
  verifier.update(signingString);
  verifier.end();

  try {
    const isValid = verifier.verify(keyData.publicKeyPem, parsed.signature, 'base64');
    return {
      verified: isValid,
      actorUri: isValid ? keyData.actorUri : undefined,
      reason: isValid ? undefined : 'verify-failed',
    };
  } catch (err) {
    options.onDebug?.('HTTP signature verification failed:', err);
    return { verified: false, reason: err instanceof Error ? err.message : 'verify-exception' };
  }
}
