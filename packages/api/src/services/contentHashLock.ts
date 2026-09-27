/**
 * One lock per content hash, shared by everything that makes stored bytes
 * belong to a LIVE row and everything that deletes stored bytes.
 *
 * Storage is content-addressed: every asset with the same `sha256` uses the
 * same keys (`content/…/<sha>.<ext>`, `variants/…/<sha>/…`), and at most one
 * live row may hold a hash (`files_sha256_live_key`). Deleting an asset
 * tombstones its row first — which frees the hash — and removes the objects
 * afterwards. In that gap a fresh upload of the same bytes can insert a new live
 * row on the same keys, and the purge then deletes the new row's bytes: a
 * permanent 404 for somebody else's upload.
 *
 * The purge therefore re-checks "does a live row hold this hash?" and deletes
 * only while holding this lock, and every path that creates a new live row takes
 * the same lock around its insert (and, where the object is written BEFORE the
 * row, around that write too). Either the insert commits first and the purge
 * sees it and keeps the bytes (`retained_shared`), or the purge finishes first
 * and the upload writes its bytes after.
 *
 * A transaction-scoped advisory lock (`pg_advisory_xact_lock`): released on
 * commit or rollback, so a crashed holder cannot strand it. The callback gets
 * the transaction and must do its database work THROUGH it — taking a second
 * pool connection while holding this one can starve the pool.
 */

import { sql } from 'drizzle-orm';
import { getDb, type Transaction } from '../config/postgres';

/** The advisory-lock namespace for content hashes; part of the hashed key. */
export const CONTENT_HASH_LOCK_NAMESPACE = 'oxy:files:sha256:';
const LOCK_NAMESPACE = CONTENT_HASH_LOCK_NAMESPACE;

export async function withContentHashLock<T>(
  sha256: string,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${LOCK_NAMESPACE + sha256}, 0))`);
    return fn(tx);
  });
}
