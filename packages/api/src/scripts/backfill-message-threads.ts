#!/usr/bin/env bun
/**
 * One-shot backfill: give every stored message its `thread_id`.
 *
 * Why it exists: `messages.thread_id` (migration 0193) is assigned on every
 * write by `services/emailThreading.ts`, but the rows stored before that image
 * shipped are NULL. The reads keep falling back to the `WITH RECURSIVE` walk
 * for them until this has run and reported zero NULLs — only then can the
 * reads switch to the stored key and the column become NOT NULL.
 *
 * What it does, per user, in batches of BATCH_SIZE unassigned rows (paged by
 * id): under the user's thread lock, `rethread` re-derives the components
 * those rows belong to and stamps them. A component that already holds
 * assigned rows (a reply that arrived after the deploy stamped part of an old
 * conversation) keeps the id most of its rows carry. Each batch commits on its
 * own, so the lock — which the user's inbound mail and sends also take — is
 * held for one batch, never for a whole mailbox.
 *
 * `--verify` then compares, for every user, the stored grouping with the
 * components computed in memory from the same keys, and reports any row that
 * is NULL or grouped differently. With `--apply` it repairs them. It is the
 * check to run before switching the reads. (An image older than the threading
 * one could have split a thread with a delete during the rollout; only this
 * pass sees that.)
 *
 * Idempotent and resumable: a re-run finds only what is still unassigned.
 * Refuses to run without an explicit mode:
 *
 *   bun run packages/api/src/scripts/backfill-message-threads.ts --dry-run [--verify]
 *   bun run packages/api/src/scripts/backfill-message-threads.ts --apply [--verify]
 *
 * Or, against the compiled output inside the oxy-api image, as a one-shot task:
 *   node packages/api/dist/scripts/backfill-message-threads.js --apply --verify
 *
 * Options: `--user=<id>` limits the run to one account (a canary first);
 * `--after-user=<id>` resumes after the last user a previous run logged.
 *
 * Env: DATABASE_URL (required), BATCH_SIZE (default 500).
 *
 * Exits non-zero after `--apply` if any NULL is left (a write from an image
 * older than the threading one, during a rollout): run it again.
 */

import { and, asc, count, eq, gt, isNull, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../config/postgres';
import { messages } from '../db/schema/messages';
import {
  rethread,
  type ThreadRow,
  threadComponents,
  threadKeys,
  withThreadLock,
} from '../services/emailThreading';
import { logger } from '../utils/logger';

/** Users listed per page while looking for work. */
const USER_PAGE = 100;

export interface BackfillStats {
  /** Users that had unassigned rows. */
  users: number;
  /** Unassigned rows found. */
  unassigned: number;
  /** Rows stamped (or, in a dry run, 0: a dry run writes nothing and counts `unassigned`). */
  stamped: number;
  /** Batches run. */
  batches: number;
  /** Users the verify pass read. */
  verifiedUsers: number;
  /** Rows the verify pass found NULL or grouped unlike their component. */
  mismatched: number;
  /** Rows the verify pass restamped (`--apply` only). */
  repaired: number;
  /** Rows still mismatched after a repair (`--apply` only); should be 0. */
  unrepaired: number;
  /** NULL `thread_id`s left in scope when the run ended. */
  remaining: number;
  /** The last user processed, for `--after-user`. */
  lastUser: string | null;
}

export interface BackfillOptions {
  apply: boolean;
  verify?: boolean;
  batchSize?: number;
  /** Only this user. */
  userId?: string;
  /** Resume: only users after this id. */
  afterUser?: string;
}

/** The next page of users with messages, optionally only those with unassigned rows. */
async function userPage(after: string, onlyUnassigned: boolean): Promise<string[]> {
  const rows = await getDb()
    .selectDistinct({ userId: messages.userId })
    .from(messages)
    .where(and(gt(messages.userId, after), onlyUnassigned ? isNull(messages.threadId) : undefined))
    .orderBy(asc(messages.userId))
    .limit(USER_PAGE);
  return rows.map((row) => row.userId);
}

/** Every user in scope, page by page. */
async function* usersInScope(options: BackfillOptions, onlyUnassigned: boolean) {
  if (options.userId) {
    yield options.userId;
    return;
  }
  let after = options.afterUser ?? '';
  for (;;) {
    const page = await userPage(after, onlyUnassigned);
    if (page.length === 0) return;
    yield* page;
    after = page[page.length - 1];
  }
}

/** Stamp one user's unassigned rows, a batch per transaction. */
async function stampUser(
  userId: string,
  options: BackfillOptions,
  stats: BackfillStats,
): Promise<void> {
  const db = getDb();
  const batchSize = options.batchSize ?? 500;
  let after = '';
  let found = false;
  for (;;) {
    const page = await db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.userId, userId), isNull(messages.threadId), gt(messages.id, after)))
      .orderBy(asc(messages.id))
      .limit(batchSize);
    if (page.length === 0) break;
    found = true;
    after = page[page.length - 1].id;
    stats.unassigned += page.length;
    stats.batches += 1;
    if (options.apply) {
      const result = await db.transaction(async (tx) => {
        await withThreadLock(tx, userId);
        return rethread(
          tx,
          userId,
          page.map((row) => row.id),
        );
      });
      stats.stamped += result.restamped;
    }
    if (page.length < batchSize) break;
  }
  if (found) stats.users += 1;
}

/**
 * The rows of one user whose stored thread disagrees with the components:
 * NULL, or sharing an id with another component, or split across two ids.
 */
async function mismatchedRows(userId: string): Promise<string[]> {
  const rows = await getDb().execute<ThreadRow>(sql`
    select m.id, m.thread_id as "threadId", ${threadKeys('m')} as keys
    from messages m
    where m.user_id = ${userId}
  `);
  const groups = threadComponents(rows);
  const componentsByThread = new Map<string, number>();
  for (const group of groups) {
    for (const threadId of new Set(group.map((row) => row.threadId))) {
      if (threadId !== null) {
        componentsByThread.set(threadId, (componentsByThread.get(threadId) ?? 0) + 1);
      }
    }
  }
  const wrong: string[] = [];
  for (const group of groups) {
    const threadIds = new Set(group.map((row) => row.threadId));
    const [only] = threadIds;
    const consistent = threadIds.size === 1 && only !== null && componentsByThread.get(only) === 1;
    if (!consistent) wrong.push(...group.map((row) => row.id));
  }
  return wrong;
}

export async function backfillMessageThreads(options: BackfillOptions): Promise<BackfillStats> {
  const stats: BackfillStats = {
    users: 0,
    unassigned: 0,
    stamped: 0,
    batches: 0,
    verifiedUsers: 0,
    mismatched: 0,
    repaired: 0,
    unrepaired: 0,
    remaining: 0,
    lastUser: null,
  };

  for await (const userId of usersInScope(options, true)) {
    await stampUser(userId, options, stats);
    stats.lastUser = userId;
    logger.info('Message threads: user done', { userId, ...stats });
  }

  if (options.verify) {
    for await (const userId of usersInScope(options, false)) {
      stats.verifiedUsers += 1;
      const wrong = await mismatchedRows(userId);
      if (wrong.length === 0) continue;
      stats.mismatched += wrong.length;
      logger.warn('Message threads: grouping differs from the components', {
        userId,
        rows: wrong.length,
      });
      if (options.apply) {
        const result = await getDb().transaction(async (tx) => {
          await withThreadLock(tx, userId);
          return rethread(tx, userId, wrong);
        });
        stats.repaired += result.restamped;
        stats.unrepaired += (await mismatchedRows(userId)).length;
      }
    }
  }

  const [left] = await getDb()
    .select({ n: count() })
    .from(messages)
    .where(
      and(
        isNull(messages.threadId),
        options.userId ? eq(messages.userId, options.userId) : undefined,
      ),
    );
  stats.remaining = left?.n ?? 0;
  return stats;
}

/** `--name=value` from the command line. */
function option(args: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  if (apply === args.includes('--dry-run')) {
    console.error('Pass exactly one of --dry-run or --apply.');
    process.exit(2);
  }

  await connectPostgres();
  try {
    const stats = await backfillMessageThreads({
      apply,
      verify: args.includes('--verify'),
      batchSize: Number(process.env.BATCH_SIZE) || undefined,
      userId: option(args, 'user'),
      afterUser: option(args, 'after-user'),
    });
    logger.info(
      apply ? 'Message threads backfilled' : 'DRY RUN — message threads that would be backfilled',
      { ...stats },
    );
    if (apply && (stats.remaining > 0 || stats.unrepaired > 0)) {
      logger.error('Message threads: rows still unassigned or mismatched; run it again', {
        remaining: stats.remaining,
        unrepaired: stats.unrepaired,
      });
      process.exitCode = 1;
    }
  } finally {
    await closePostgres();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    logger.error(
      'backfill-message-threads failed',
      error instanceof Error ? error : new Error(String(error)),
    );
    process.exit(1);
  });
}
