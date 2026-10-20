/**
 * Folder counts as the readers need them: the stored counters on `mailboxes`,
 * and the aggregate over `messages` for any folder not counted yet.
 *
 * `mailboxes.total_messages`, `unseen_messages` and `size_bytes` are kept by
 * the triggers in `db/schema/mailboxCounters.ts`; NULL means the folder
 * predates them and `scripts/backfill-mailbox-counters.ts` has not counted it
 * (see `db/schema/mailboxes.ts`, with the measurement). A counted folder is
 * read in O(1); an uncounted one costs exactly what every folder cost before,
 * with the same predicate (`user_id` first, so the same indexes serve it).
 * Once the backfill reports zero NULL folders, the fallbacks never run.
 */

import { and, eq, inArray, not, sql } from 'drizzle-orm';
import type { DatabaseOrTransaction } from '../config/postgres';
import { mailboxes } from '../db/schema/mailboxes';
import { messages } from '../db/schema/messages';

export interface FolderCounts {
  total: number;
  unseen: number;
  bytes: number;
}

/** The counter columns of one folder row, as `select … from mailboxes` returns them. */
export interface StoredFolderCounters {
  id: string;
  totalMessages: number | null;
  unseenMessages: number | null;
  sizeBytes: number | null;
}

const EMPTY: FolderCounts = { total: 0, unseen: 0, bytes: 0 };

/**
 * The counts of folders already read from `mailboxes`, all owned by `userId`.
 * Counted folders come from their columns; the rest from ONE grouped
 * aggregate. A folder with no mail reads as zeros.
 */
export async function resolveFolderCounts(
  db: DatabaseOrTransaction,
  userId: string,
  folders: readonly StoredFolderCounters[],
): Promise<Map<string, FolderCounts>> {
  const counts = new Map<string, FolderCounts>();
  const uncounted: string[] = [];
  for (const folder of folders) {
    if (
      folder.totalMessages === null ||
      folder.unseenMessages === null ||
      folder.sizeBytes === null
    ) {
      uncounted.push(folder.id);
    } else {
      counts.set(folder.id, {
        total: folder.totalMessages,
        unseen: folder.unseenMessages,
        bytes: folder.sizeBytes,
      });
    }
  }
  if (uncounted.length === 0) return counts;

  const rows = await db
    .select({
      mailboxId: messages.mailboxId,
      total: sql<number>`count(*)::int`,
      unseen: sql<number>`(count(*) filter (where not ${messages.seen}))::int`,
      // `sum()` is `numeric`; postgres.js hands a bigint back as a string.
      bytes: sql<string>`coalesce(sum(${messages.size}), 0)::bigint`,
    })
    .from(messages)
    .where(and(eq(messages.userId, userId), inArray(messages.mailboxId, uncounted)))
    .groupBy(messages.mailboxId);
  const aggregated = new Map(rows.map((row) => [row.mailboxId, row]));
  for (const id of uncounted) {
    const row = aggregated.get(id);
    counts.set(
      id,
      row ? { total: row.total, unseen: row.unseen, bytes: Number(row.bytes) } : { ...EMPTY },
    );
  }
  return counts;
}

/**
 * The unread count of each named folder the user owns, in one read of
 * `mailboxes` (plus one grouped aggregate over the unread rows of any folder
 * not counted yet). A folder the user does not own is absent.
 */
export async function unreadCounts(
  db: DatabaseOrTransaction,
  userId: string,
  mailboxIds: readonly string[],
): Promise<Map<string, number>> {
  if (mailboxIds.length === 0) return new Map();
  const folders = await db
    .select({ id: mailboxes.id, unseen: mailboxes.unseenMessages })
    .from(mailboxes)
    .where(and(eq(mailboxes.userId, userId), inArray(mailboxes.id, [...mailboxIds])));

  const unread = new Map<string, number>();
  const uncounted: string[] = [];
  for (const folder of folders) {
    if (folder.unseen === null) uncounted.push(folder.id);
    else unread.set(folder.id, folder.unseen);
  }
  if (uncounted.length === 0) return unread;

  // Led by `user_id` and filtered on `not seen`: the prefix of the partial
  // `messages_unseen_idx`, an index-only scan over just the unread rows.
  const rows = await db
    .select({ mailboxId: messages.mailboxId, unread: sql<number>`count(*)::int` })
    .from(messages)
    .where(
      and(eq(messages.userId, userId), inArray(messages.mailboxId, uncounted), not(messages.seen)),
    )
    .groupBy(messages.mailboxId);
  const aggregated = new Map(rows.map((row) => [row.mailboxId, row.unread]));
  for (const id of uncounted) unread.set(id, aggregated.get(id) ?? 0);
  return unread;
}

/**
 * The bytes and the number of messages a user stores, across every folder:
 * what the mail quota and the account storage page charge.
 *
 * The sum of the folders' counters while every folder is counted; otherwise
 * the aggregate over the user's messages, exactly as before.
 */
export async function storedMail(
  db: DatabaseOrTransaction,
  userId: string,
): Promise<{ bytes: number; count: number }> {
  const [counted] = await db
    .select({
      bytes: sql<string>`coalesce(sum(${mailboxes.sizeBytes}), 0)::bigint`,
      count: sql<string>`coalesce(sum(${mailboxes.totalMessages}), 0)::bigint`,
      uncounted: sql<boolean>`coalesce(bool_or(${mailboxes.sizeBytes} is null or ${mailboxes.totalMessages} is null), false)`,
    })
    .from(mailboxes)
    .where(eq(mailboxes.userId, userId));
  if (counted && !counted.uncounted) {
    return { bytes: Number(counted.bytes), count: Number(counted.count) };
  }

  const [aggregated] = await db
    .select({
      bytes: sql<string>`coalesce(sum(${messages.size}), 0)::bigint`,
      count: sql<string>`count(*)`,
    })
    .from(messages)
    .where(eq(messages.userId, userId));
  return { bytes: Number(aggregated?.bytes ?? 0), count: Number(aggregated?.count ?? 0) };
}
