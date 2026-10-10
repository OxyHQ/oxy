#!/usr/bin/env bun
/**
 * One-time cleanup: remove the pseudo-attachments that inbound parsing used to
 * create from a message's ALTERNATIVE BODY — the AMP (`text/x-amp-html`) or
 * Apple Watch (`text/watch-html`) rendering of a `multipart/alternative`.
 *
 * Why it exists: before `services/inboundMime.ts`, mailparser's rule "every
 * leaf that is not text/plain or text/html is an attachment" put a file named
 * "attachment" under every transactional mail that shipped AMP (Ramp, Google,
 * Booking…). New mail no longer gets one; this removes the ones already stored.
 *
 * What counts: an attachment row whose content type is one of
 * {@link ALTERNATIVE_BODY_TYPES} AND whose name is the parser's fallback
 * `'attachment'` — i.e. the sender gave it no filename. A deliberately attached
 * `.amp.html` file keeps its name and is left alone.
 *
 * For each: the file is unlinked from the message through `AssetService`
 * (which moves an orphaned file to trash, where the normal GC reclaims it —
 * the SAME path deleting a message takes), the attachment row is deleted, and
 * the message's `size` gives back the bytes it was charged for.
 *
 * Idempotent. Refuses to run without an explicit mode:
 *
 *   bun run packages/api/src/scripts/purge-alternative-body-attachments.ts --dry-run
 *   bun run packages/api/src/scripts/purge-alternative-body-attachments.ts --apply
 *
 * Or, against the compiled output inside the oxy-api image:
 *   node packages/api/dist/scripts/purge-alternative-body-attachments.js --dry-run
 *
 * Env: DATABASE_URL (required), BATCH_SIZE (default 200).
 */

import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../config/postgres';
import { messageAttachments } from '../db/schema/messageAttachments';
import { messages } from '../db/schema/messages';
import { assetService } from '../services/assetServiceSingleton';
import { ALTERNATIVE_BODY_TYPES } from '../services/inboundMime';
import { logger } from '../utils/logger';

/** The name `inboundMime` / its predecessors stored for a part with no filename. */
const UNNAMED_PART = 'attachment';

export interface PurgeStats {
  matched: number;
  removed: number;
  bytesReclaimed: number;
  messagesTouched: number;
  errors: number;
}

export async function purgeAlternativeBodyAttachments(options: {
  apply: boolean;
  batchSize?: number;
}): Promise<PurgeStats> {
  const db = getDb();
  const batchSize = options.batchSize ?? 200;
  const stats: PurgeStats = {
    matched: 0,
    removed: 0,
    bytesReclaimed: 0,
    messagesTouched: 0,
    errors: 0,
  };
  const touched = new Set<string>();
  const types = [...ALTERNATIVE_BODY_TYPES];
  let after = '';

  for (;;) {
    const page = await db
      .select({
        id: messageAttachments.id,
        fileId: messageAttachments.fileId,
        size: messageAttachments.size,
        messageRowId: messageAttachments.messageId,
        rfcMessageId: messages.messageId,
      })
      .from(messageAttachments)
      .innerJoin(messages, eq(messages.id, messageAttachments.messageId))
      .where(
        and(
          inArray(sql`lower(${messageAttachments.contentType})`, types),
          eq(messageAttachments.name, UNNAMED_PART),
          after ? gt(messageAttachments.id, after) : undefined,
        ),
      )
      .orderBy(asc(messageAttachments.id))
      .limit(batchSize);

    if (page.length === 0) break;
    after = page[page.length - 1].id;
    stats.matched += page.length;

    for (const row of page) {
      touched.add(row.messageRowId);
      if (!options.apply) {
        stats.bytesReclaimed += row.size;
        continue;
      }
      try {
        // Both entity ids: attachments were linked under the row id, and older
        // rows under the RFC Message-ID — `deleteMessageAttachments` unlinks both.
        for (const entityId of new Set([row.messageRowId, row.rfcMessageId])) {
          try {
            await assetService.unlinkFile(row.fileId, 'oxy-mail', 'message', entityId);
          } catch (error) {
            // A missing link under one of the two ids is expected; the row goes regardless.
            logger.warn('Could not unlink an alternative-body attachment file', {
              fileId: row.fileId,
              entityId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        await db.transaction(async (tx) => {
          const deleted = await tx
            .delete(messageAttachments)
            .where(eq(messageAttachments.id, row.id))
            .returning({ id: messageAttachments.id });
          if (deleted.length === 0) return;
          await tx
            .update(messages)
            .set({ size: sql`greatest(${messages.size} - ${row.size}, 0)` })
            .where(eq(messages.id, row.messageRowId));
        });
        stats.removed += 1;
        stats.bytesReclaimed += row.size;
      } catch (error) {
        stats.errors += 1;
        logger.error(
          'Could not remove an alternative-body attachment',
          error instanceof Error ? error : new Error(String(error)),
          {
            attachmentId: row.id,
            messageId: row.messageRowId,
          },
        );
      }
    }

    if (page.length < batchSize) break;
  }

  stats.messagesTouched = touched.size;
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
    const stats = await purgeAlternativeBodyAttachments({
      apply,
      batchSize: Number(process.env.BATCH_SIZE) || undefined,
    });
    logger.info(
      apply
        ? 'Alternative-body attachments purged'
        : 'DRY RUN — alternative-body attachments that would be purged',
      { ...stats },
    );
    if (stats.errors > 0) process.exitCode = 1;
  } finally {
    await closePostgres();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    logger.error(
      'purge-alternative-body-attachments failed',
      error instanceof Error ? error : new Error(String(error)),
    );
    process.exit(1);
  });
}
