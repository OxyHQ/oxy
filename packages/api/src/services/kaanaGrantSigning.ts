/**
 * The two signatures of Kaana ADR 0002's grant lane, in the one scheme every
 * signed Oxy↔Kaana body already uses (Kaana `internal/edgeauth`):
 *
 * ```text
 * X-Oxy-Kaana-Key-Id       the signing key's id
 * X-Oxy-Kaana-Timestamp    Unix milliseconds, when it was signed
 * X-Oxy-Kaana-Signature    v1=<base64 Ed25519 signature>
 *
 * signed over  <domain>\n<key id>\n<timestamp>\n<lowercase hex sha256 of the exact body>
 * ```
 *
 *  - **The grant** (`oxy-kaana-grant:v1`): Oxy signs the body of a successful
 *    authorization with the SAME Ed25519 key it signs envelopes with
 *    (`KAANA_EDGE_SIGNING_PRIVATE_KEY`), so Kaana verifies it against the
 *    `KAANA_EDGE_PUBLIC_KEYS` it already holds. The domain separator is what
 *    keeps a grant from being replayed as an envelope and an envelope as a
 *    grant.
 *  - **The settlement** (`kaana-oxy-settlement:v1`): Kaana signs each delivered
 *    settlement with its OWN key, whose public half Oxy holds
 *    (`config/kaanaSettlementKeys.ts`). Oxy cannot mint a settlement it would
 *    accept, exactly as Kaana cannot mint a grant.
 *
 * The signing input is `signatureInput` from `@kaana.ai/contracts/internal`, so
 * the bytes signed here are the bytes Kaana's verifier rebuilds by definition.
 */

import { createHash, type KeyObject, sign, verify } from 'node:crypto';
import {
  GRANT_SIGNATURE_DOMAIN,
  SETTLEMENT_SIGNATURE_DOMAIN,
  signatureInput,
} from '@kaana.ai/contracts/internal';
import type { KaanaDataPlaneConfig } from '../config/kaanaDataPlane';

export const KAANA_KEY_ID_HEADER = 'X-Oxy-Kaana-Key-Id';
export const KAANA_TIMESTAMP_HEADER = 'X-Oxy-Kaana-Timestamp';
export const KAANA_SIGNATURE_HEADER = 'X-Oxy-Kaana-Signature';

const SIGNATURE_PREFIX = 'v1=';

/**
 * How far a settlement's signing time may be from now. Kaana's outbox signs at
 * DELIVERY, so a redelivery carries a fresh timestamp; the window is the same
 * five minutes `edgeauth` grants an envelope.
 */
export const SETTLEMENT_MAX_SKEW_MS = 5 * 60_000;

export function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface SignedHeaders {
  readonly [KAANA_KEY_ID_HEADER]: string;
  readonly [KAANA_TIMESTAMP_HEADER]: string;
  readonly [KAANA_SIGNATURE_HEADER]: string;
}

/** Sign a grant body with the Oxy edge key under {@link GRANT_SIGNATURE_DOMAIN}. */
export function signGrantBody(
  config: Pick<KaanaDataPlaneConfig, 'keyId' | 'privateKey'>,
  body: Buffer,
  timestampMillis: number,
): SignedHeaders {
  const input = signatureInput(
    GRANT_SIGNATURE_DOMAIN,
    config.keyId,
    timestampMillis,
    sha256Hex(body),
  );
  const signature = sign(null, Buffer.from(input, 'utf8'), config.privateKey).toString('base64');
  return {
    [KAANA_KEY_ID_HEADER]: config.keyId,
    [KAANA_TIMESTAMP_HEADER]: String(timestampMillis),
    [KAANA_SIGNATURE_HEADER]: `${SIGNATURE_PREFIX}${signature}`,
  };
}

export type SettlementSignatureCheck =
  | { readonly ok: true; readonly keyId: string }
  | {
      readonly ok: false;
      readonly reason: 'missing' | 'unknown-key' | 'stale' | 'malformed' | 'bad-signature';
    };

/**
 * Verify a settlement Kaana delivered. One refusal shape for every cause on the
 * wire (the route answers 401 alike); `reason` is for the log.
 */
export function verifySettlementSignature(
  headers: {
    readonly keyId: string | undefined;
    readonly timestamp: string | undefined;
    readonly signature: string | undefined;
  },
  body: Buffer,
  keys: ReadonlyMap<string, KeyObject>,
  nowMillis: number,
): SettlementSignatureCheck {
  const { keyId, timestamp, signature } = headers;
  if (keyId === undefined || timestamp === undefined || signature === undefined) {
    return { ok: false, reason: 'missing' };
  }
  const key = keys.get(keyId);
  if (key === undefined) return { ok: false, reason: 'unknown-key' };
  if (!/^[0-9]{1,16}$/.test(timestamp)) return { ok: false, reason: 'malformed' };
  const signedAt = Number(timestamp);
  if (Math.abs(nowMillis - signedAt) > SETTLEMENT_MAX_SKEW_MS)
    return { ok: false, reason: 'stale' };
  if (!signature.startsWith(SIGNATURE_PREFIX)) return { ok: false, reason: 'malformed' };
  const encoded = signature.slice(SIGNATURE_PREFIX.length);
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length !== 64 || bytes.toString('base64') !== encoded) {
    return { ok: false, reason: 'malformed' };
  }
  const input = signatureInput(SETTLEMENT_SIGNATURE_DOMAIN, keyId, signedAt, sha256Hex(body));
  return verify(null, Buffer.from(input, 'utf8'), key, bytes)
    ? { ok: true, keyId }
    : { ok: false, reason: 'bad-signature' };
}
