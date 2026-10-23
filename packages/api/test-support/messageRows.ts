/**
 * Insert a `messages` row in a test the way the ONE production insert path
 * does (`insertMessageWithChildren`): under the owner's thread lock, with the
 * `thread_id` its Message-ID keys put it in (`services/emailThreading.ts`).
 *
 * `thread_id` is NOT NULL, so a test row needs one, and a made-up value would
 * be wrong exactly where a test is about threads: two rows that reference each
 * other must share it, and a row bridging two threads merges them. This
 * assigns it the production way, so the stored grouping a read sees is the
 * one the write paths would have left.
 */

import { getDb } from '../src/config/postgres';
import { messages } from '../src/db/schema/messages';
import { assignThread, threadKeysOf, withThreadLock } from '../src/services/emailThreading';

type MessageValues = Omit<typeof messages.$inferInsert, 'threadId'>;

/** Insert one row with its thread assigned; returns the stored row. */
export async function insertMessageRow(
  values: MessageValues,
): Promise<typeof messages.$inferSelect> {
  return getDb().transaction(async (tx) => {
    await withThreadLock(tx, values.userId);
    const threadId = await assignThread(tx, values.userId, threadKeysOf(values));
    const [row] = await tx
      .insert(messages)
      .values({ ...values, threadId })
      .returning();
    return row;
  });
}

/** Insert rows one at a time, in order, so each sees the ones before it. */
export async function insertMessageRows(
  rows: readonly MessageValues[],
): Promise<Array<typeof messages.$inferSelect>> {
  const inserted = [];
  for (const values of rows) inserted.push(await insertMessageRow(values));
  return inserted;
}
