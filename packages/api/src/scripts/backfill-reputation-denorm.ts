#!/usr/bin/env bun
/**
 * One-time migration: backfill the denormalized reputation fields
 * (`reputationRankWeight`, `reputationTier`) on existing User rows from the
 * authoritative `reputation_balances` table.
 *
 * Why it exists:
 *   `reputationService.recalculateBalance` keeps these two User fields in sync
 *   with `ReputationBalance.influence.rankingFeedbackWeight` /
 *   `ReputationBalance.trustTier` going forward, but users whose balance was last
 *   recomputed before the denorm change have stale defaults
 *   (`reputationRankWeight = INFLUENCE_MIN`, `reputationTier = 'new'`). The
 *   recommendation scorer joins on these denorm fields, so they must be populated
 *   for the reputation signal and the restricted-floor to take effect.
 *
 * Behavior:
 *   - Iterates `reputation_balances` in batches (one row per user).
 *   - For each balance, writes `reputationRankWeight` + `reputationTier` onto the
 *     matching User when the denorm values diverge.
 *   - Idempotent — safe to re-run.
 *
 * Run (inside the oxy-api image, working dir /app):
 *   bun run packages/api/src/scripts/backfill-reputation-denorm.ts
 * Or, against the compiled output:
 *   node packages/api/dist/scripts/backfill-reputation-denorm.js
 *
 * Env:
 *   DATABASE_URL   Postgres connection string (required, injected by ECS from SSM)
 *   BATCH_SIZE     Number of balances to scan per batch (default 500)
 *   DRY_RUN=true   Report what would change without writing
 */

import { eq, gt, inArray } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../config/postgres';
import { reputationBalances } from '../db/schema/reputationBalances';
import { users } from '../db/schema/users';
import { INFLUENCE_MIN } from '../utils/reputation.constants';
import type { TrustTier } from '@oxyhq/contracts';
import { logger } from '../utils/logger';

interface BackfillStats {
  scanned: number;
  updated: number;
  unchanged: number;
  missingUser: number;
  errors: number;
}

async function backfillReputationDenorm(): Promise<BackfillStats> {
  const stats: BackfillStats = {
    scanned: 0,
    updated: 0,
    unchanged: 0,
    missingUser: 0,
    errors: 0,
  };

  const batchSize = Number(process.env.BATCH_SIZE) || 500;
  const dryRun = process.env.DRY_RUN === 'true';

  if (dryRun) {
    logger.info('DRY RUN — no writes will be performed');
  }

  let lastUserId = '';

  for (;;) {
    const balances = await getDb()
      .select({
        userId: reputationBalances.userId,
        trustTier: reputationBalances.trustTier,
        rankWeight: reputationBalances.influenceRankingFeedbackWeight,
      })
      .from(reputationBalances)
      .where(lastUserId ? gt(reputationBalances.userId, lastUserId) : undefined)
      .orderBy(reputationBalances.userId)
      .limit(batchSize);

    if (balances.length === 0) {
      break;
    }

    const userIds = balances.map((balance) => balance.userId);
    const existingUsers = await getDb()
      .select({
        id: users.id,
        reputationRankWeight: users.reputationRankWeight,
        reputationTier: users.reputationTier,
      })
      .from(users)
      .where(inArray(users.id, userIds));

    const userById = new Map(existingUsers.map((user) => [user.id, user]));

    const pending: Array<{
      userId: string;
      reputationRankWeight: number;
      reputationTier: TrustTier;
    }> = [];

    for (const balance of balances) {
      stats.scanned += 1;
      lastUserId = balance.userId;

      const user = userById.get(balance.userId);
      if (!user) {
        stats.missingUser += 1;
        continue;
      }

      const rankWeight =
        typeof balance.rankWeight === 'number' ? balance.rankWeight : INFLUENCE_MIN;
      const tier: TrustTier = balance.trustTier ?? 'new';

      const currentWeight =
        typeof user.reputationRankWeight === 'number' ? user.reputationRankWeight : undefined;
      const currentTier = user.reputationTier;

      if (currentWeight === rankWeight && currentTier === tier) {
        stats.unchanged += 1;
        continue;
      }

      stats.updated += 1;
      pending.push({
        userId: balance.userId,
        reputationRankWeight: rankWeight,
        reputationTier: tier,
      });
    }

    if (pending.length > 0 && !dryRun) {
      try {
        await getDb().transaction(async (tx) => {
          for (const update of pending) {
            await tx
              .update(users)
              .set({
                reputationRankWeight: update.reputationRankWeight,
                reputationTier: update.reputationTier,
              })
              .where(eq(users.id, update.userId));
          }
        });
      } catch (error) {
        stats.errors += pending.length;
        logger.error(
          'batch update failed during reputation-denorm backfill',
          error instanceof Error ? error : new Error(String(error)),
          { component: 'backfill', method: 'flush' },
        );
      }
    }
  }

  return stats;
}

async function main(): Promise<void> {
  await connectPostgres();
  logger.info('Connected to Postgres');

  try {
    const startedAt = Date.now();
    const stats = await backfillReputationDenorm();
    const elapsedMs = Date.now() - startedAt;
    logger.info('Reputation-denorm backfill finished', {
      ...stats,
      elapsedMs,
    });
  } finally {
    await closePostgres();
    logger.info('Postgres connection closed');
  }
}

main().catch((error) => {
  logger.error(
    'Backfill failed',
    error instanceof Error ? error : new Error(String(error)),
    { component: 'backfill', method: 'main' },
  );
  process.exit(1);
});
