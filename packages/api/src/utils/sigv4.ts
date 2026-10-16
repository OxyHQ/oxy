/**
 * AWS Signature Version 4 verification for an S3-compatible endpoint Oxy
 * serves itself (ADR 0042 stage 4c: a recording target's ingest, written by a
 * LiveKit egress through the AWS SDK).
 *
 * Header-signed requests only (`Authorization: AWS4-HMAC-SHA256 …`), service
 * `s3`, any region the client names. The payload hash is the client's
 * `x-amz-content-sha256`: a hex SHA-256 (the caller verifies it against the
 * body it reads), `UNSIGNED-PAYLOAD`, or `STREAMING-UNSIGNED-PAYLOAD-TRAILER`
 * (an aws-chunked body; see `awsChunked.ts`). Signed streaming chunks
 * (`STREAMING-AWS4-HMAC-SHA256-PAYLOAD…`) are not supported — an S3 client over
 * HTTPS does not send them — and are refused.
 *
 * The canonical request follows the S3 variant of SigV4: the URI path exactly
 * as the client sent it (S3 does not normalize or double-encode it), the query
 * re-encoded and sorted, the signed headers trimmed with inner whitespace
 * collapsed.
 */

import crypto from 'node:crypto';

/** How far a request's `x-amz-date` may be from now. */
export const SIGV4_MAX_CLOCK_SKEW_MS = 15 * 60 * 1000;

export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
export const STREAMING_UNSIGNED_PAYLOAD_TRAILER = 'STREAMING-UNSIGNED-PAYLOAD-TRAILER';

/** Why a request's signature was refused, as S3 names it. */
export type SigV4Failure =
  | 'MissingSecurityHeader'
  | 'AuthorizationHeaderMalformed'
  | 'InvalidAccessKeyId'
  | 'RequestTimeTooSkewed'
  | 'SignatureDoesNotMatch'
  | 'NotImplemented';

export class SigV4Error extends Error {
  constructor(
    readonly code: SigV4Failure,
    message: string,
  ) {
    super(message);
    this.name = 'SigV4Error';
  }
}

export interface SigV4Request {
  method: string;
  /** The request target as received: path and query, still percent-encoded. */
  rawUrl: string;
  /** Lowercased header names. */
  headers: Record<string, string | string[] | undefined>;
}

export interface ParsedAuthorization {
  accessKeyId: string;
  date: string;
  region: string;
  service: string;
  signedHeaders: string[];
  signature: string;
}

/** The access key of a request's `Authorization`, before its secret is known. */
export function parseSigV4Authorization(header: string | undefined): ParsedAuthorization {
  if (!header) throw new SigV4Error('MissingSecurityHeader', 'The request is not signed');
  const match =
    /^AWS4-HMAC-SHA256\s+Credential=([^,\s]+)\s*,\s*SignedHeaders=([^,\s]+)\s*,\s*Signature=([0-9a-f]{64})\s*$/.exec(
      header.trim(),
    );
  if (!match) {
    throw new SigV4Error('AuthorizationHeaderMalformed', 'The authorization header is malformed');
  }
  const scope = match[1].split('/');
  if (scope.length !== 5 || scope[4] !== 'aws4_request' || !/^\d{8}$/.test(scope[1])) {
    throw new SigV4Error('AuthorizationHeaderMalformed', 'The credential scope is malformed');
  }
  return {
    accessKeyId: scope[0],
    date: scope[1],
    region: scope[2],
    service: scope[3],
    signedHeaders: match[2].split(';'),
    signature: match[3],
  };
}

function single(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value.join(',');
  return value;
}

/** RFC 3986 encoding as SigV4 wants it: everything but unreserved characters. */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, '%20'));
  } catch {
    return value;
  }
}

function canonicalQuery(rawQuery: string): string {
  if (!rawQuery) return '';
  return rawQuery
    .split('&')
    .filter((part) => part.length > 0)
    .map((part) => {
      const eq = part.indexOf('=');
      const name = eq < 0 ? part : part.slice(0, eq);
      const value = eq < 0 ? '' : part.slice(eq + 1);
      return [uriEncode(safeDecode(name)), uriEncode(safeDecode(value))] as const;
    })
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
}

function hmac(key: crypto.BinaryLike, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

/** The signing key for (secret, date, region, service). */
export function sigV4SigningKey(
  secret: string,
  date: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmac(`AWS4${secret}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

/**
 * Verify `request` against `secret`. Returns the client's payload hash
 * declaration (`x-amz-content-sha256`) for the caller to honour. Throws
 * {@link SigV4Error} otherwise.
 */
export function verifySigV4(
  request: SigV4Request,
  auth: ParsedAuthorization,
  secret: string,
  now = new Date(),
): { payloadHash: string } {
  if (auth.service !== 's3') {
    throw new SigV4Error('AuthorizationHeaderMalformed', 'Only the s3 service is signed here');
  }
  const amzDate = single(request.headers['x-amz-date']);
  if (!amzDate || !/^\d{8}T\d{6}Z$/.test(amzDate) || amzDate.slice(0, 8) !== auth.date) {
    throw new SigV4Error('AuthorizationHeaderMalformed', 'x-amz-date is missing or malformed');
  }
  const signedAt = Date.UTC(
    Number(amzDate.slice(0, 4)),
    Number(amzDate.slice(4, 6)) - 1,
    Number(amzDate.slice(6, 8)),
    Number(amzDate.slice(9, 11)),
    Number(amzDate.slice(11, 13)),
    Number(amzDate.slice(13, 15)),
  );
  if (Math.abs(now.getTime() - signedAt) > SIGV4_MAX_CLOCK_SKEW_MS) {
    throw new SigV4Error(
      'RequestTimeTooSkewed',
      'The request time is too far from the server time',
    );
  }
  const payloadHash = single(request.headers['x-amz-content-sha256']);
  if (!payloadHash) {
    throw new SigV4Error('MissingSecurityHeader', 'x-amz-content-sha256 is required');
  }
  if (
    payloadHash !== UNSIGNED_PAYLOAD &&
    payloadHash !== STREAMING_UNSIGNED_PAYLOAD_TRAILER &&
    !/^[0-9a-f]{64}$/.test(payloadHash)
  ) {
    throw new SigV4Error('NotImplemented', `Payload signing "${payloadHash}" is not supported`);
  }
  const signed = [...auth.signedHeaders].sort();
  if (!signed.includes('host') || !signed.includes('x-amz-date')) {
    throw new SigV4Error('AuthorizationHeaderMalformed', 'host and x-amz-date must be signed');
  }
  if (!signed.includes('x-amz-content-sha256')) {
    throw new SigV4Error('AuthorizationHeaderMalformed', 'x-amz-content-sha256 must be signed');
  }
  const canonicalHeaders = signed
    .map((name) => {
      const value = single(request.headers[name]);
      if (value === undefined) {
        throw new SigV4Error('SignatureDoesNotMatch', `Signed header ${name} is missing`);
      }
      return `${name}:${value.trim().replace(/\s+/g, ' ')}\n`;
    })
    .join('');

  const queryAt = request.rawUrl.indexOf('?');
  const path = queryAt < 0 ? request.rawUrl : request.rawUrl.slice(0, queryAt);
  const query = queryAt < 0 ? '' : request.rawUrl.slice(queryAt + 1);
  const canonicalRequest = [
    request.method.toUpperCase(),
    path || '/',
    canonicalQuery(query),
    canonicalHeaders,
    signed.join(';'),
    payloadHash,
  ].join('\n');
  const scope = `${auth.date}/${auth.region}/${auth.service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    crypto.createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
  ].join('\n');
  const expected = hmac(
    sigV4SigningKey(secret, auth.date, auth.region, auth.service),
    stringToSign,
  ).toString('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(auth.signature, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new SigV4Error('SignatureDoesNotMatch', 'The request signature does not match');
  }
  return { payloadHash };
}
