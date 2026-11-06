#!/usr/bin/env bun
/**
 * One-shot backfill: every profile link Oxy still holds as a URL gets a Clarity
 * document id, so the follow-up migration can drop the URL columns.
 *
 * Two sources are covered, because both held URLs before this change:
 *
 *   1. `user_link_metadata` rows with no `clarity_document_id` yet: the id is
 *      written onto the row, keeping its position and the owner's title.
 *   2. `users.links` for an account with NO link rows at all (a profile that
 *      only ever had the bare URL list): one row per URL is created, in order.
 *
 * Each URL is asked of Clarity with `indexing.resolve`, waiting for a crawl that
 * is already running. A URL Clarity has not fetched yet, or refuses, is left as
 * it is and reported. Re-run the script to pick those up; it only ever touches
 * rows that still lack an id, so it is resumable and idempotent.
 *
 * The URL columns are NOT touched here. Dropping them is the follow-up
 * migration, and it only runs once `--apply` reports nothing left unresolved.
 *
 *   bun run packages/api/src/scripts/backfill-clarity-link-documents.ts            # dry run (default)
 *   bun run packages/api/src/scripts/backfill-clarity-link-documents.ts --apply
 *   … --user=<id>      one account (a canary)
 *
 * Env: DATABASE_URL (required). It runs as Oxy's workload identity, as the API does.
 */

import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../config/postgres';
import { userLinkMetadata } from '../db/schema/userLinkMetadata';
import { users } from '../db/schema/users';
import { logger } from '../utils/logger';
import { resolveLinkDocuments } from '../services/clarityLinkDocuments.service';

/** How long each URL waits for a crawl Clarity has already started. */
const WAIT_MS = 8000;

interface Options {
  apply: boolean;
  userId?: string;
}

function parseOptions(argv: readonly string[]): Options {
  const userArg = argv.find((arg) => arg.startsWith('--user='));
  return {
    apply: argv.includes('--apply'),
    userId: userArg?.slice('--user='.length),
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  await connectPostgres();
  const db = getDb();

  const scope = options.userId ? eq(userLinkMetadata.userId, options.userId) : undefined;
  const unmigrated = await db
    .select({
      id: userLinkMetadata.id,
      userId: userLinkMetadata.userId,
      url: userLinkMetadata.url,
    })
    .from(userLinkMetadata)
    .where(and(isNull(userLinkMetadata.clarityDocumentId), isNotNull(userLinkMetadata.url), scope))
    .orderBy(asc(userLinkMetadata.userId), asc(userLinkMetadata.position));

  const usersWithRows = db.select({ userId: userLinkMetadata.userId }).from(userLinkMetadata);
  const bareLinkUsers = await db
    .select({ id: users.id, links: users.links })
    .from(users)
    .where(
      and(
        sql`cardinality(${users.links}) > 0`,
        sql`${users.id} not in (${usersWithRows})`,
        options.userId ? eq(users.id, options.userId) : undefined,
      ),
    );

  const urls = new Set<string>([
    ...unmigrated.map((row) => row.url).filter((url): url is string => url !== null),
    ...bareLinkUsers.flatMap((user) => (user.links ?? []).map((url) => url.trim())),
  ]);
  const { documents, pending } = await resolveLinkDocuments([...urls], WAIT_MS);
  const unresolved = new Set(pending.map((entry) => entry.url));

  let written = 0;
  if (options.apply) {
    for (const row of unmigrated) {
      if (!row.url) continue;
      const document = documents.get(row.url);
      if (!document) continue;
      await db
        .update(userLinkMetadata)
        .set({ clarityDocumentId: document.id })
        .where(and(eq(userLinkMetadata.id, row.id), isNull(userLinkMetadata.clarityDocumentId)));
      written += 1;
    }
    for (const user of bareLinkUsers) {
      await db.transaction(async (tx) => {
        // The account row lock serialises this with a concurrent profile save,
        // which replaces the link rows under the same lock.
        await tx.select({ id: users.id }).from(users).where(eq(users.id, user.id)).for('update');
        const [existing] = await tx
          .select({ id: userLinkMetadata.id })
          .from(userLinkMetadata)
          .where(eq(userLinkMetadata.userId, user.id))
          .limit(1);
        if (existing) return;
        const rows: (typeof userLinkMetadata.$inferInsert)[] = [];
        for (const url of user.links ?? []) {
          const document = documents.get(url.trim());
          if (!document || rows.some((row) => row.clarityDocumentId === document.id)) continue;
          rows.push({
            userId: user.id,
            position: rows.length,
            clarityDocumentId: document.id,
            title: null,
          });
        }
        if (rows.length > 0) {
          await tx.insert(userLinkMetadata).values(rows);
          written += rows.length;
        }
      });
    }
  }

  logger.info('Clarity link-document backfill', {
    apply: options.apply,
    rowsWithoutDocument: unmigrated.length,
    accountsWithBareLinks: bareLinkUsers.length,
    distinctUrls: urls.size,
    resolved: documents.size,
    unresolved: unresolved.size,
    written,
  });
  for (const url of unresolved) logger.warn('Link not resolved yet; re-run to retry', { url });

  if (options.apply && unresolved.size > 0) process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    logger.error('Clarity link-document backfill failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePostgres();
  });
