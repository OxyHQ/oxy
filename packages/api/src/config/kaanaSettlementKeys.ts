/**
 * The public keys Oxy verifies Kaana's settlements with (Kaana ADR 0002,
 * decision 3: "clave privada nueva de Kaana en SSM; Oxy guarda la pública").
 *
 * ```text
 * KAANA_SETTLEMENT_PUBLIC_KEYS   kid:base64,kid:base64   (raw 32-byte Ed25519 keys)
 * ```
 *
 * The same `kid:base64` list shape Kaana's own `KAANA_EDGE_PUBLIC_KEYS` takes,
 * so a rotation is the same operation on both sides: add the new key, deploy,
 * switch the signer, remove the old one. Public keys are not secrets and belong
 * in the task definition's plain environment.
 *
 * **Absent means no settlement is accepted**, never "accept unsigned": the
 * settlement route answers 503 and the reconciler (which reads Kaana over its
 * own authenticated channel) is the only way a grant closes.
 */

import { createPublicKey, type KeyObject } from 'node:crypto';
import { logger } from '../utils/logger';

export const KAANA_SETTLEMENT_PUBLIC_KEYS_VARIABLE = 'KAANA_SETTLEMENT_PUBLIC_KEYS';

/** The DER prefix of an Ed25519 SubjectPublicKeyInfo; the 32 raw key bytes follow it. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export type KaanaSettlementKeyResolution =
  | { readonly status: 'configured'; readonly keys: ReadonlyMap<string, KeyObject> }
  | { readonly status: 'absent' }
  | { readonly status: 'unreadable'; readonly entry: number };

/** Parse `kid:base64,kid:base64`. Any malformed entry makes the whole set unreadable. */
export function parseKaanaSettlementKeys(raw: string | undefined): KaanaSettlementKeyResolution {
  const value = raw?.trim() ?? '';
  if (value.length === 0) return { status: 'absent' };
  const keys = new Map<string, KeyObject>();
  const entries = value.split(',');
  for (const [index, entry] of entries.entries()) {
    const separator = entry.indexOf(':');
    const keyId = entry.slice(0, separator).trim();
    const encoded = entry.slice(separator + 1).trim();
    const bytes = Buffer.from(encoded, 'base64');
    if (
      separator <= 0 ||
      !KEY_ID_PATTERN.test(keyId) ||
      keys.has(keyId) ||
      bytes.length !== 32 ||
      bytes.toString('base64') !== encoded
    ) {
      return { status: 'unreadable', entry: index };
    }
    keys.set(
      keyId,
      createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, bytes]),
        format: 'der',
        type: 'spki',
      }),
    );
  }
  return { status: 'configured', keys };
}

/** This deployment's settlement keys, read per call so a test can set the variable. */
export function resolveKaanaSettlementKeys(): KaanaSettlementKeyResolution {
  const resolution = parseKaanaSettlementKeys(process.env[KAANA_SETTLEMENT_PUBLIC_KEYS_VARIABLE]);
  if (resolution.status === 'unreadable') {
    logger.error(
      'inference.settlement.keys_unreadable',
      new Error(`${KAANA_SETTLEMENT_PUBLIC_KEYS_VARIABLE} entry ${resolution.entry} is malformed`),
      { expected: 'kid:base64 of a raw 32-byte Ed25519 public key, comma separated' },
    );
  }
  return resolution;
}
