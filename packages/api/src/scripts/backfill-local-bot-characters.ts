#!/usr/bin/env bun
/**
 * Repair pre-character Oxy bots, without replacing any stored look or federated identity.
 * Default is read-only. Apply requires the exact inventory hash printed by dry-run:
 *   bun packages/api/src/scripts/backfill-local-bot-characters.ts --dry-run
 *   bun packages/api/src/scripts/backfill-local-bot-characters.ts --apply --expected-hash=<sha256>
 * DATABASE_URL is required; REDIS_URL enables the normal cross-app identity invalidation.
 */
import { createHash } from 'node:crypto';
import { avatarCharacterFor } from '@oxy.so/contracts';
import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../config/postgres';
import { closeRedis, getRedisClient } from '../config/redis';
import { users } from '../db/schema/users';
import userCache from '../utils/userCache';

const eligible = () =>
  and(
    eq(users.kind, 'bot'),
    isNull(users.character),
    isNull(users.federationActorUri),
    ne(users.type, 'federated'),
    ne(users.accountStatus, 'archived'),
  );
async function boundedRedisPing(redis: NonNullable<ReturnType<typeof getRedisClient>>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      redis.ping(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Redis invalidation readiness/drain timed out.')),
          5000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const columns = { id: users.id, username: users.username, type: users.type };

function inventory(rows: { id: string; username: string | null; type: string }[]) {
  const candidates = rows.map((row) => {
    if (!row.username?.trim())
      throw new Error(
        `Bot ${row.id} has no canonical username; repair its identity before seeding a character.`,
      );
    return { ...row, username: row.username, character: avatarCharacterFor(row.username) };
  });
  const hash = createHash('sha256').update(JSON.stringify(candidates)).digest('hex');
  return { candidates, hash };
}

export async function backfillLocalBotCharacters(
  options: { apply?: boolean; expectedHash?: string } = {},
) {
  const db = getDb();
  if (!options.apply) {
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION READ ONLY`);
      await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
      return tx.select(columns).from(users).where(eligible()).orderBy(asc(users.id));
    });
    return { apply: false, ...inventory(rows), changed: [] as string[] };
  }
  if (!/^[a-f0-9]{64}$/.test(options.expectedHash ?? ''))
    throw new Error('Apply requires the dry-run --expected-hash.');
  const redis = getRedisClient();
  // A one-shot process must open and verify its connection before the normal
  // invalidator checks status=ready. A failed configured Redis aborts before writes.
  if (redis) await boundedRedisPing(redis);
  const report = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
    await tx.execute(sql`SET LOCAL statement_timeout = '15s'`);
    // Row locks close the inventory/write race. The write also repeats every eligibility
    // condition and username: a renamed, archived or concurrently authored bot is never overwritten.
    const rows = await tx
      .select(columns)
      .from(users)
      .where(eligible())
      .orderBy(asc(users.id))
      .for('update');
    const plan = inventory(rows);
    if (plan.hash !== options.expectedHash)
      throw new Error('Bot inventory changed; run dry-run and review its new hash.');
    const changed: string[] = [];
    for (const row of plan.candidates) {
      const updated = await tx
        .update(users)
        .set({ character: row.character, updatedAt: new Date() })
        .where(and(eligible(), eq(users.id, row.id), eq(users.username, row.username)))
        .returning({ id: users.id });
      if (updated.length !== 1)
        throw new Error('Bot eligibility changed; transaction rolled back.');
      changed.push(row.id);
    }
    return { apply: true, ...plan, changed };
  });
  for (const id of report.changed) userCache.invalidate(id);
  // DEL/PUBLISH are queued synchronously on this connection. PING is their
  // ordered drain barrier; closing Redis before it resolves loses invalidations.
  if (redis) await boundedRedisPing(redis);
  return { ...report, invalidation: redis ? 'redis-drained' : 'local-only-no-redis' };
}

async function main() {
  const args = process.argv.slice(2);
  if (
    args.some(
      (arg) => arg !== '--apply' && arg !== '--dry-run' && !arg.startsWith('--expected-hash='),
    ) ||
    (args.includes('--apply') && args.includes('--dry-run'))
  ) {
    throw new Error('Use --dry-run or --apply --expected-hash=<sha256>.');
  }
  await connectPostgres();
  try {
    const report = await backfillLocalBotCharacters({
      apply: args.includes('--apply'),
      expectedHash: args
        .find((arg) => arg.startsWith('--expected-hash='))
        ?.slice('--expected-hash='.length),
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    await closePostgres();
    await closeRedis();
  }
}
if (require.main === module)
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
