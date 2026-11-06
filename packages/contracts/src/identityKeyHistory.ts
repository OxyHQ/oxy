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
 */
import { z } from 'zod';
import { isoDateTime } from './stringChecks';

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
