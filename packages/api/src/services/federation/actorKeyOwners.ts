/**
 * Binding the key pairs that predate `federation_key_pairs.oxy_user_id` to the
 * account lifetime they belong to (`actorKeys.ts` has the rule). Run once, as
 * `scripts/reconcile-federation-key-owners.ts`; idempotent, since it only reads
 * rows whose owner is still null.
 *
 * Each legacy user key is decided from the account holding its handle now and
 * from Oxy's deletion ledger (`account_events`, 30 days of `account.deleted`
 * with the handle the account had):
 *
 *  - `bound` — the holder's own key: minted after the holder's account was, and
 *    no deletion of another account with that handle came after it. Bound to
 *    the holder; the live key does not change.
 *  - `replaced` — the holder inherited it: the key is older than the holder's
 *    account, or another account holding the handle was deleted after the key
 *    was minted. Replaced with a fresh pair bound to the holder.
 *  - `bound-to-deleted` — nobody holds the handle and a recorded deletion ended
 *    the key's account. Bound to that account, so its actor `Delete` can still be
 *    signed and the next account to claim the handle gets a fresh key.
 *  - `removed` — nobody holds the handle and no deletion on record explains it
 *    (deleted more than 30 days ago, or renamed away). No account can use it
 *    and any Delete it signed has long settled, so the row is deleted.
 *  - `instance` — the instance actor's key, which no account owns. Untouched.
 */

import { and, asc, desc, eq, gt, gte, isNull, sql } from 'drizzle-orm';
import { getDb } from '../../config/postgres';
import { accountEvents } from '../../db/schema/accountEvents';
import { federationKeyPairs } from '../../db/schema/federationKeyPairs';
import { findHandleHolder, handleOfKeyId, replaceKeyPair } from './actorKeys';

export const KEY_OWNER_DECISIONS = [
  'bound',
  'replaced',
  'bound-to-deleted',
  'removed',
  'instance',
] as const;
export type KeyOwnerDecision = (typeof KEY_OWNER_DECISIONS)[number];

export interface KeyOwnerSummary {
  apply: boolean;
  scanned: number;
  decisions: Record<KeyOwnerDecision, number>;
  /** Rows scanned per keyId host. */
  domains: Record<string, number>;
}

interface LegacyRow {
  id: string;
  keyId: string;
  createdAt: Date;
}

/** The most recent deletion of an account that held `handle`, at or after `since`. */
async function deletionSince(handle: string, since: Date): Promise<{ userId: string } | null> {
  const [row] = await getDb()
    .select({ userId: accountEvents.userId })
    .from(accountEvents)
    .where(
      and(
        eq(accountEvents.type, 'account.deleted'),
        sql`lower(btrim(${accountEvents.username})) = lower(btrim(${handle}))`,
        gte(accountEvents.createdAt, since),
      ),
    )
    .orderBy(desc(accountEvents.createdAt))
    .limit(1);
  return row ?? null;
}

/** Decide one legacy row and, with `apply`, carry the decision out. */
async function reconcileRow(row: LegacyRow, apply: boolean): Promise<KeyOwnerDecision> {
  const handle = handleOfKeyId(row.keyId);
  if (handle === null) return 'instance';

  const [holder, deletion] = await Promise.all([
    findHandleHolder(handle),
    deletionSince(handle, row.createdAt),
  ]);
  const stillLegacy = and(
    eq(federationKeyPairs.keyId, row.keyId),
    isNull(federationKeyPairs.oxyUserId),
  );

  if (holder) {
    const inherited =
      row.createdAt < holder.createdAt || (deletion !== null && deletion.userId !== holder.id);
    if (inherited) {
      if (apply) await replaceKeyPair({ keyId: row.keyId, oxyUserId: null }, holder.id);
      return 'replaced';
    }
    if (apply) {
      await getDb().update(federationKeyPairs).set({ oxyUserId: holder.id }).where(stillLegacy);
    }
    return 'bound';
  }

  if (deletion) {
    if (apply) {
      await getDb()
        .update(federationKeyPairs)
        .set({ oxyUserId: deletion.userId })
        .where(stillLegacy);
    }
    return 'bound-to-deleted';
  }

  if (apply) await getDb().delete(federationKeyPairs).where(stillLegacy);
  return 'removed';
}

function hostOf(keyId: string): string {
  try {
    return new URL(keyId).host;
  } catch {
    return '(invalid)';
  }
}

/**
 * Walk every key pair with no owner, in id order, `batchSize` at a time. With
 * `handles`, `explain` is called with the decision for each row whose handle is
 * listed — handles and decisions only, never key material.
 */
export async function reconcileFederationKeyOwners(options: {
  apply: boolean;
  batchSize: number;
  handles?: ReadonlySet<string>;
  explain?: (entry: { host: string; handle: string; decision: KeyOwnerDecision }) => void;
}): Promise<KeyOwnerSummary> {
  const summary: KeyOwnerSummary = {
    apply: options.apply,
    scanned: 0,
    decisions: Object.fromEntries(KEY_OWNER_DECISIONS.map((d) => [d, 0])) as Record<
      KeyOwnerDecision,
      number
    >,
    domains: {},
  };

  let after: string | null = null;
  for (;;) {
    const batch: LegacyRow[] = await getDb()
      .select({
        id: federationKeyPairs.id,
        keyId: federationKeyPairs.keyId,
        createdAt: federationKeyPairs.createdAt,
      })
      .from(federationKeyPairs)
      .where(
        and(
          isNull(federationKeyPairs.oxyUserId),
          after === null ? undefined : gt(federationKeyPairs.id, after),
        ),
      )
      .orderBy(asc(federationKeyPairs.id))
      .limit(options.batchSize);
    if (batch.length === 0) break;

    for (const row of batch) {
      const decision = await reconcileRow(row, options.apply);
      const host = hostOf(row.keyId);
      summary.scanned += 1;
      summary.decisions[decision] += 1;
      summary.domains[host] = (summary.domains[host] ?? 0) + 1;
      const handle = handleOfKeyId(row.keyId);
      if (handle !== null && options.handles?.has(handle)) {
        options.explain?.({ host, handle, decision });
      }
    }
    after = batch[batch.length - 1].id;
  }
  return summary;
}
