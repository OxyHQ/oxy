/**
 * A personal account's key history (`GET /identity/key-history`), without Zod.
 * Schema: `../identityKeyHistory.ts`.
 *
 * Part of `@oxy.so/contracts/client`: never import `zod` here (see `./check.ts`).
 */

import type { IdentityKeyHistory } from '../identityKeyHistory';
import { array, datetime, exact, nullable, pattern, strictObject, string } from './check';

const canonicalPublicKey = string(pattern(/^04[0-9a-f]{128}$/));

export const identityKeyHistoryCheck = exact<IdentityKeyHistory>()(
  strictObject({
    publicKey: nullable(canonicalPublicKey),
    retired: array(strictObject({ publicKey: canonicalPublicKey, retiredAt: string(datetime) })),
  }),
);

/**
 * The `action` a `POST /identity/key-history/claim` signature names: the signed
 * message is `JSON.stringify({ action, userId, publicKey, timestamp })`.
 */
export const IDENTITY_KEY_HISTORY_CLAIM_ACTION = 'claim_retired_identity_key' as const;
