/**
 * One lock per content hash, shared by everything that makes stored bytes
 * belong to a LIVE row and everything that deletes stored bytes.
 *
 * Storage is content-addressed and SHARED: every owner's row for the same
 * `sha256` points at the same keys (`content/…/<sha>.<ext>`,
 * `variants/…/<sha>/…`), one live row per owner. Deleting an asset tombstones
 * its row first and removes the objects afterwards, and only the spellings no
 * live row still uses. In that gap a fresh upload of the same bytes — by anyone
 * — can insert a new live row on the same keys, and an unguarded purge would
 * then delete the new row's bytes: a permanent 404 for somebody else's upload.
 *
 * The purge therefore re-checks "does a live row use this key?" and deletes
 * only while holding this lock, and every path that makes a live row use a key
 * takes the same lock: the insert of a new row (with the choice of which
 * existing key it shares, and — where the object is written BEFORE the row —
 * that write), and the copy-and-repoint of a visibility relocation. Either the
 * row commits first and the purge sees it and keeps the bytes
 * (`retained_shared`), or the purge finishes first and the upload writes its
 * bytes after.
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
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${LOCK_NAMESPACE + sha256}, 0))`,
    );
    return fn(tx);
  });
}
