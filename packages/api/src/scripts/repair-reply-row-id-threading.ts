#!/usr/bin/env bun
/**
 * One-time repair: replies whose `In-Reply-To` names a database ROW id instead
 * of an RFC 5322 Message-ID.
 *
 * Why it exists: the Inbox client's keyboard reply sent `message._id` as
 * `inReplyTo`. The Sent row stored the bare id (`01a0…`), nodemailer wrapped
 * it as `<01a0…>` on the wire, and every copy that arrived at an Oxy mailbox —
 * the sender's own included — stored that. Neither form matches any
 * `message_id`, so each such reply sat outside its conversation. oxy-api now
 * refuses the shape (`resolveReplyThreading`); this fixes the rows already
 * written.
 *
 * For every message whose `in_reply_to` is a row id, bare or bracketed, that
 * resolves to an existing message: `in_reply_to` becomes that message's
 * `message_id`, and `references` becomes its chain (its `references`, or
 * failing that its `in_reply_to`, then its `message_id` — RFC 5322 §3.6.4)
 * followed by any valid ids the row already carried. Row-id entries in
 * `references` are dropped. The lookup is not scoped to the row's owner on
 * purpose: a recipient's copy names the SENDER's row, and that row's
 * `message_id` is the header the sender meant to write.
 *
 * Idempotent. Refuses to run without an explicit mode:
 *
 *   bun run packages/api/src/scripts/repair-reply-row-id-threading.ts --dry-run
 *   bun run packages/api/src/scripts/repair-reply-row-id-threading.ts --apply
 *
 * Or, against the compiled output inside the oxy-api image:
 *   node packages/api/dist/scripts/repair-reply-row-id-threading.js --dry-run
 *
 * Env: DATABASE_URL (required), BATCH_SIZE (default 500).
 */

import { rfcMessageIdSchema } from '@oxy.so/contracts';
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../config/postgres';
import { messages } from '../db/schema/messages';
import { logger } from '../utils/logger';

/** A row id as it was written: a UUID, optionally wrapped in angle brackets. */
const ROW_ID_REFERENCE = '^<?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}>?$';

const stripBrackets = (value: string) => value.replace(/^<|>$/g, '');
const isMessageId = (value: string) => rfcMessageIdSchema.safeParse(value).success;

export interface RepairStats {
  matched: number;
  repaired: number;
  unresolved: number;
}

export async function repairReplyRowIdThreading(options: { apply: boolean; batchSize?: number }): Promise<RepairStats> {
  const db = getDb();
  const batchSize = options.batchSize ?? 500;
  const stats: RepairStats = { matched: 0, repaired: 0, unresolved: 0 };
  let after = '';

  for (;;) {
    const page = await db
      .select({ id: messages.id, inReplyTo: messages.inReplyTo, references: messages.references })
      .from(messages)
      .where(and(sql`${messages.inReplyTo} ~ ${ROW_ID_REFERENCE}`, after ? gt(messages.id, after) : undefined))
      .orderBy(asc(messages.id))
      .limit(batchSize);
    if (page.length === 0) break;
    after = page[page.length - 1].id;
    stats.matched += page.length;

    const parentIds = [...new Set(page.map((row) => stripBrackets(row.inReplyTo ?? '')))];
    const parents = await db
      .select({
        id: messages.id,
        messageId: messages.messageId,
        inReplyTo: messages.inReplyTo,
        references: messages.references,
      })
      .from(messages)
      .where(inArray(messages.id, parentIds));
    const byId = new Map(parents.map((parent) => [parent.id, parent]));

    for (const row of page) {
      const parent = byId.get(stripBrackets(row.inReplyTo ?? ''));
      if (!parent || !isMessageId(parent.messageId)) {
        stats.unresolved += 1;
        continue;
      }
      const ancestry = parent.references.length > 0 ? parent.references : parent.inReplyTo ? [parent.inReplyTo] : [];
      const references = [...new Set([...ancestry, parent.messageId, ...row.references])].filter(isMessageId);

      if (options.apply) {
        await db
          .update(messages)
          .set({ inReplyTo: parent.messageId, references })
          .where(eq(messages.id, row.id));
      }
      stats.repaired += 1;
    }

    if (page.length < batchSize) break;
  }
  return stats;
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const apply = args.has('--apply');
  if (apply === args.has('--dry-run')) {
    console.error('Pass exactly one of --dry-run or --apply.');
    process.exit(2);
  }

  await connectPostgres();
  try {
    const stats = await repairReplyRowIdThreading({ apply, batchSize: Number(process.env.BATCH_SIZE) || undefined });
    logger.info(apply ? 'Reply threading repaired' : 'DRY RUN — reply threading that would be repaired', { ...stats });
  } finally {
    await closePostgres();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    logger.error('repair-reply-row-id-threading failed', error instanceof Error ? error : new Error(String(error)));
    process.exit(1);
  });
}
