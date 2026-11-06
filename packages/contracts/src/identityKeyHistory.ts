/**
 * A personal account's key history: `GET /identity/key-history`.
 *
 * The current root (`null` without one) and every root a rotation replaced,
 * oldest first. Commons reads it to accept a previous recovery phrase only when
 * it derives a key that WAS this account's root, and keeps that key to spend
 * what it received. A retired root is never any account's again (ADR 0061 D2).
 *
 * Keys are canonical: uncompressed, lowercase (`04` + 128 hex). No private key
 * or phrase crosses this contract.
 *
 * The Zod-free check is `./client/identityKeyHistory.ts`.
 *
 * `POST /identity/key-history/claim` (security review R6-5) adds a root that
 * was replaced BEFORE the history existed (migration 0235): Commons proves it
 * holds the key (`signature` over `{ action: 'claim_retired_identity_key',
 * userId, publicKey, timestamp }`, the rotation proof's signing format) and the
 * server adds it only when its OWN records show the key was this account's
 * (`services/personalKeyEvidence.ts`). The answer is the key history.
 */
import { z } from 'zod';
import { integerCheck } from './numberChecks';
import { isoDateTime, utf16MinLength } from './stringChecks';

const canonicalPublicKey = z.string().regex(/^04[0-9a-f]{128}$/);

export const identityKeyHistorySchema = z
  .object({
    publicKey: canonicalPublicKey.nullable(),
    retired: z.array(
      z
        .object({
          publicKey: canonicalPublicKey,
          retiredAt: z.string().check(isoDateTime()),
        })
        .strict(),
    ),
  })
  .strict();
export type IdentityKeyHistory = z.infer<typeof identityKeyHistorySchema>;

export { IDENTITY_KEY_HISTORY_CLAIM_ACTION } from './client/identityKeyHistory';

/**
 * Body of `POST /identity/key-history/claim`. `signature` is
 * `signMessage(JSON.stringify({ action: 'claim_retired_identity_key', userId,
 * publicKey, timestamp }), privateKey)` (that key order), `timestamp` Unix
 * milliseconds within five minutes of the server's clock.
 */
export const identityKeyHistoryClaimRequestSchema = z
  .object({
    publicKey: canonicalPublicKey,
    signature: z.string().check(utf16MinLength(1)).max(256),
    timestamp: z.number().check(integerCheck()).positive(),
  })
  .strict();
export type IdentityKeyHistoryClaimRequest = z.infer<typeof identityKeyHistoryClaimRequestSchema>;
