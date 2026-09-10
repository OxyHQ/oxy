/**
 * Chain continuity — the pure "does this record extend the head by exactly one?"
 * check, with NO storage or crypto dependency.
 *
 * This is the single definition of continuity that used to be duplicated in
 * oxy-api (`verifyChainContinuity`) and the node store (`appendTxn`). The engine
 * calls it with the head it read from the injected store; a store MAY call it
 * again inside its atomic append, but the unique-index backstop (surfaced as
 * `chain_conflict`) is the real race guard.
 *
 * v1 envelopes have no chain coordinates, so they always pass (the caller does
 * not advance a chain for them).
 */

import type { SignedRecordEnvelope } from '@oxy.so/contracts';
import type { ChainHead, VerifyOutcome } from './types';

/**
 * True when `head` represents an actual existing chain (as opposed to `null` or
 * the "no chain yet" sentinel head a store may return).
 */
function hasChain(head: ChainHead | null): head is ChainHead & { headRecordId: string } {
  return head !== null && head.headRecordId !== null && head.seq >= 0;
}

/**
 * Check that `env` validly extends `head`:
 *
 *  - **v1** (no chain coordinates): always `{ ok: true }` — v1 records are not
 *    chained.
 *  - **no head** (genesis position): only a genesis (`seq === 0`, `prev` null)
 *    is accepted; anything else is `chain_gap` (it claims to extend a chain that
 *    does not exist).
 *  - **head exists**: `env.prev` MUST equal `head.headRecordId` (else
 *    `chain_fork`, which also covers a re-genesis whose `prev` is `null`), and
 *    `env.seq` MUST equal `head.seq + 1` (else `bad_seq`).
 */
export function checkContinuity(head: ChainHead | null, env: SignedRecordEnvelope): VerifyOutcome {
  if (env.version !== 2) {
    return { ok: true };
  }

  const isGenesis = env.seq === 0 && (env.prev === null || env.prev === undefined);

  if (!hasChain(head)) {
    if (!isGenesis) {
      return { ok: false, reason: 'chain_gap' };
    }
    return { ok: true };
  }

  if (env.prev !== head.headRecordId) {
    return { ok: false, reason: 'chain_fork' };
  }
  if (env.seq !== head.seq + 1) {
    return { ok: false, reason: 'bad_seq' };
  }
  return { ok: true };
}
