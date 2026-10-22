#!/usr/bin/env bun
/**
 * One-shot backfill: count every folder whose `mailboxes.total_messages`,
 * `unseen_messages` or `size_bytes` is still NULL.
 *
 * Why it exists: 0205 added the three counters nullable, so every folder that
 * existed then reads NULL ("not counted yet"), and 0206's triggers keep NULL as
 * NULL (`col = col + delta`). Folders created after 0207 start at 0 and need
 * nothing. Until every folder is counted, the readers fall back to the
 * aggregate over `messages` (see `db/schema/mailboxes.ts`).
 *
 * How one folder is counted, and why it is exact with writers running: one
 * READ COMMITTED transaction per folder that
 *
 *   1. locks the folder row `FOR NO KEY UPDATE` — the lock the trigger takes;
 *   2. counts in a NEW statement, whose snapshot is taken after the lock was
 *      granted, and writes the three numbers.
 *
 * A writer whose trigger ran before step 1 holds that lock until it commits,
 * so step 1 waits and step 2 sees its rows. A writer whose trigger runs after
 * step 1 waits for this transaction, then adds its delta to the counted value
 * (its UPDATE re-reads the row it waited for). Counting in the SAME statement
 * as the lock would be wrong: that statement's snapshot predates the wait.
 * The lock is held for one folder's count, never for a batch.
 *
 * Resumable and idempotent: only NULL folders are picked, so a re-run continues
 * where the last one stopped (or pass `--after=<last logged mailbox id>`); a
 * folder that fails (a lock wait past `lock_timeout`) is logged, skipped, and
 * picked up by the next run.
 *
 * `--verify` then compares every COUNTED folder (in scope) with the aggregate,
 * in one statement per page. One snapshot sees the counters and the messages
 * consistently, because the trigger writes both in the same transaction, so a
 * difference is real drift, not a race. With `--apply` it recounts drifted
 * folders the same locked way. It also reports messages filed in another
 * account's folder: no folder counts them (only the owner's mail counts, as in
 * the aggregate the counters replace), and they are the one shape under which
 * the per-user sum of the folder counters differs from the per-user sum of
 * `messages.size` — the quota's old definition.
 *
 *   bun run packages/api/src/scripts/backfill-mailbox-counters.ts --dry-run
 *   bun run packages/api/src/scripts/backfill-mailbox-counters.ts --apply [--verify]
 *   … --user=<id>              one account (a canary)
 *   … --after=<mailbox id>     resume after this folder id
 *
 * Or, against the compiled output inside the oxy-api image:
 *   node packages/api/dist/scripts/backfill-mailbox-counters.js --dry-run
 *
 * Exits non-zero after `--apply` if any folder in scope is still NULL or could
 * not be counted (a drifted one that was recounted is not a failure).
 *
 * Env: DATABASE_URL (required), BATCH_SIZE (default 500 folders per page).
 */

import { and, asc, eq, gt, isNull, or, type SQL, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../config/postgres';
import { mailboxes } from '../db/schema/mailboxes';
import { logger } from '../utils/logger';

/** How long one folder waits for a writer's lock before it is skipped for the next run. */
const FOLDER_LOCK_TIMEOUT = '10s';

export interface BackfillMailboxCountersOptions {
  apply: boolean;
  /** Also compare every counted folder with the aggregate (and recount drift under `apply`). */
  verify?: boolean;
  batchSize?: number;
  /** Only this account's folders. */
  userId?: string;
  /** Only folders whose id sorts after this one. */
  after?: string;
  /**
   * Test seam: awaited while a folder's lock is held, before it is counted, so
   * a test can make a writer queue behind the backfill.
   */
  onLocked?: (mailboxId: string) => Promise<void>;
}

export interface BackfillMailboxCountersStats {
  /** NULL folders found (in scope). */
  uncounted: number;
  /** Folders this run counted (or recounted, after drift). */
  counted: number;
  /** NULL when paged, counted by another run before this one locked it. */
  alreadyCounted: number;
  /** Folders that could not be counted this run (logged). */
  failed: number;
  /** NULL folders left in scope after the run. */
  remaining: number;
  /** Last folder id this run reached; pass it as `--after` to resume. */
  lastMailboxId: string | null;
  /** `--verify`: counted folders compared with the aggregate. */
  verified: number;
  /** `--verify`: folders whose counters disagreed with the aggregate. */
  drifted: number;
  /** `--verify`: messages whose `user_id` differs from their folder's. */
  crossOwnerMessages: number;
}

const anyCounterNull = or(
  isNull(mailboxes.totalMessages),
  isNull(mailboxes.unseenMessages),
  isNull(mailboxes.sizeBytes),
);

function scope(options: BackfillMailboxCountersOptions, after: string): SQL | undefined {
  return and(
    after ? gt(mailboxes.id, after) : undefined,
    options.userId ? eq(mailboxes.userId, options.userId) : undefined,
  );
}

/**
 * Count one folder under its lock. `recount` also rewrites a folder that is
 * already counted (drift repair); otherwise one counted since it was paged is
 * left alone.
 */
async function countFolder(
  mailboxId: string,
  recount: boolean,
  onLocked: BackfillMailboxCountersOptions['onLocked'],
): Promise<'counted' | 'already' | 'gone'> {
  return getDb().transaction(
    async (tx) => {
      await tx.execute(sql.raw(`set local lock_timeout = '${FOLDER_LOCK_TIMEOUT}'`));
      const [locked] = await tx
        .select({
          total: mailboxes.totalMessages,
          unseen: mailboxes.unseenMessages,
          bytes: mailboxes.sizeBytes,
        })
        .from(mailboxes)
        .where(eq(mailboxes.id, mailboxId))
        .for('no key update');
      if (!locked) return 'gone';
      const counted = locked.total !== null && locked.unseen !== null && locked.bytes !== null;
      if (counted && !recount) return 'already';

      await onLocked?.(mailboxId);

      // A NEW statement: its snapshot is taken now, after the lock was granted.
      // Only the owner's mail counts, as in the trigger (`mailboxCounters.ts`).
      await tx.execute(sql`
        update mailboxes as m
        set (total_messages, unseen_messages, size_bytes) = (
          select count(*)::integer,
                 (count(*) filter (where not x.seen))::integer,
                 coalesce(sum(x.size), 0)::bigint
          from messages x
          where x.mailbox_id = m.id and x.user_id = m.user_id
        )
        where m.id = ${mailboxId}
      `);
      return 'counted';
    },
    { isolationLevel: 'read committed' },
  );
}

async function countOrLog(
  mailboxId: string,
  recount: boolean,
  options: BackfillMailboxCountersOptions,
  stats: BackfillMailboxCountersStats,
): Promise<void> {
  try {
    const outcome = await countFolder(mailboxId, recount, options.onLocked);
    if (outcome === 'counted') stats.counted += 1;
    if (outcome === 'already') stats.alreadyCounted += 1;
  } catch (error) {
    stats.failed += 1;
    logger.warn('Could not count a mailbox; the next run picks it up', {
      mailboxId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function countUncounted(
  options: BackfillMailboxCountersOptions,
  batchSize: number,
  stats: BackfillMailboxCountersStats,
): Promise<void> {
  let after = options.after ?? '';
  for (;;) {
    const page = await getDb()
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .where(and(anyCounterNull, scope(options, after)))
      .orderBy(asc(mailboxes.id))
      .limit(batchSize);
    if (page.length === 0) break;

    for (const { id } of page) {
      stats.uncounted += 1;
      if (options.apply) await countOrLog(id, false, options, stats);
      after = id;
    }
    stats.lastMailboxId = after;
    logger.info('backfill-mailbox-counters progress', {
      lastMailboxId: after,
      uncounted: stats.uncounted,
      counted: stats.counted,
      failed: stats.failed,
    });
    if (page.length < batchSize) break;
  }
}

async function verifyCounted(
  options: BackfillMailboxCountersOptions,
  batchSize: number,
  stats: BackfillMailboxCountersStats,
): Promise<void> {
  let after = options.after ?? '';
  for (;;) {
    // One statement per page: one snapshot for the counters and the messages.
    const page = await getDb().execute<{ id: string; drifted: boolean }>(sql`
      select m.id,
             (m.total_messages, m.unseen_messages, m.size_bytes)
               is distinct from (s.total, s.unseen, s.bytes) as drifted
      from mailboxes m
      cross join lateral (
        select count(*)::integer as total,
               (count(*) filter (where not x.seen))::integer as unseen,
               coalesce(sum(x.size), 0)::bigint as bytes
        from messages x
        where x.mailbox_id = m.id and x.user_id = m.user_id
      ) s
      where m.total_messages is not null
        and m.unseen_messages is not null
        and m.size_bytes is not null
        ${after ? sql`and m.id > ${after}` : sql``}
        ${options.userId ? sql`and m.user_id = ${options.userId}` : sql``}
      order by m.id
      limit ${batchSize}
    `);
    if (page.length === 0) break;

    for (const row of page) {
      stats.verified += 1;
      if (row.drifted) {
        stats.drifted += 1;
        logger.warn('Mailbox counters drifted from the aggregate', { mailboxId: row.id });
        if (options.apply) await countOrLog(row.id, true, options, stats);
      }
      after = row.id;
    }
    if (page.length < batchSize) break;
  }

  const [crossOwner] = await getDb().execute<{ n: number }>(sql`
    select count(*)::integer as n
    from messages x
    join mailboxes m on m.id = x.mailbox_id
    where x.user_id <> m.user_id
      ${options.userId ? sql`and (x.user_id = ${options.userId} or m.user_id = ${options.userId})` : sql``}
  `);
  stats.crossOwnerMessages = crossOwner?.n ?? 0;
}

export async function backfillMailboxCounters(
  options: BackfillMailboxCountersOptions,
): Promise<BackfillMailboxCountersStats> {
  const batchSize = options.batchSize ?? 500;
  const stats: BackfillMailboxCountersStats = {
    uncounted: 0,
    counted: 0,
    alreadyCounted: 0,
    failed: 0,
    remaining: 0,
    lastMailboxId: null,
    verified: 0,
    drifted: 0,
    crossOwnerMessages: 0,
  };

  await countUncounted(options, batchSize, stats);
  if (options.verify) await verifyCounted(options, batchSize, stats);

  const [left] = await getDb()
    .select({ n: sql<number>`count(*)::integer` })
    .from(mailboxes)
    .where(and(anyCounterNull, options.userId ? eq(mailboxes.userId, options.userId) : undefined));
  stats.remaining = left?.n ?? 0;
  return stats;
}

function flagValue(args: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) || undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  if (apply === args.includes('--dry-run')) {
    console.error('Pass exactly one of --dry-run or --apply.');
    process.exit(2);
  }

  await connectPostgres();
  let failed = false;
  try {
    const stats = await backfillMailboxCounters({
      apply,
      verify: args.includes('--verify'),
      batchSize: Number(process.env.BATCH_SIZE) || undefined,
      userId: flagValue(args, 'user'),
      after: flagValue(args, 'after'),
    });
    logger.info(
      apply ? 'Mailbox counters backfilled' : 'DRY RUN — mailbox counters that would be backfilled',
      { ...stats },
    );
    // After `--apply` every drifted folder was recounted, so `drifted` alone is
    // not a failure; a recount that did not happen is counted in `failed`.
    failed = apply && (stats.remaining > 0 || stats.failed > 0);
  } finally {
    await closePostgres();
  }
  if (failed) process.exit(1);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    logger.error(
      'backfill-mailbox-counters failed',
      error instanceof Error ? error : new Error(String(error)),
    );
    process.exit(1);
  });
}
