/**
 * Exact metadata-only counts for one client-defined local calendar day.
 *
 * The client knows the user's timezone and sends the UTC bounds. This query
 * deliberately selects only four aggregates: no sender, subject, message body
 * or attachment metadata crosses this boundary into the inference prompt.
 */

import { and, eq, exists, gte, lt, sql } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { messageAttachments } from '../db/schema/messageAttachments';
import { messages } from '../db/schema/messages';

export interface InboxDailyBriefCounts {
  readonly total: number;
  readonly unread: number;
  readonly starred: number;
  readonly withAttachments: number;
}

/** Count every owned message whose RFC date is in the half-open UTC interval. */
export async function getInboxDailyBriefCounts(
  userId: string,
  startAt: Date,
  endAt: Date,
): Promise<InboxDailyBriefCounts> {
  const db = getDb();
  const attachmentRows = db
    .select({ one: sql`1` })
    .from(messageAttachments)
    .where(eq(messageAttachments.messageId, messages.id));

  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      unread: sql<number>`count(*) filter (where not ${messages.seen})::int`,
      starred: sql<number>`count(*) filter (where ${messages.starred})::int`,
      withAttachments: sql<number>`count(*) filter (where ${exists(attachmentRows)})::int`,
    })
    .from(messages)
    .where(and(
      eq(messages.userId, userId),
      gte(messages.date, startAt),
      lt(messages.date, endAt),
    ));

  return {
    total: row?.total ?? 0,
    unread: row?.unread ?? 0,
    starred: row?.starred ?? 0,
    withAttachments: row?.withAttachments ?? 0,
  };
}
