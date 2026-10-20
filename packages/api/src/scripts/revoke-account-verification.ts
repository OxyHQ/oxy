#!/usr/bin/env node
/**
 * Clear `users.verified` on child accounts that `createChildAccount` minted
 * verified. It used to insert `verified: true` for every project, organization,
 * bot and channel, which showed the badge and promoted the account to the
 * `verified` trust tier with no personhood behind it.
 *
 * `users.verified` belongs to personhood (`recomputePersonhood`), so this script
 * never touches a `personal` account: a person's flag is derived, not edited.
 * After clearing the flag it runs `reputationService.recalculateBalance`, which
 * rewrites `reputation_balances.trustTier` and `users.reputationTier` and
 * invalidates `userCache`, so the tier drops along with the badge.
 *
 * - each argument is a username (case-insensitive) or an account id, and must
 *   name exactly one account;
 * - ANY refusal stops the whole run before anything is written;
 * - idempotent: an account already unverified is reported and left alone.
 *
 * DRY-RUN BY DEFAULT: without `--confirm` it prints what it would do and
 * changes nothing. Output is JSON on stdout (ids and usernames only).
 *
 * Run (inside the oxy-api image, working dir /app, as a one-off ECS task on the
 * live task definition with only `command` overridden):
 *   node packages/api/dist/scripts/revoke-account-verification.js alice acme            # dry run
 *   node packages/api/dist/scripts/revoke-account-verification.js alice acme --confirm  # write
 *
 * Env: DATABASE_URL (and the API's usual env: Redis for the user cache).
 */

import { eq, or, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../config/postgres';
import { closeRedis } from '../config/redis';
import { users } from '../db/schema/users';
import { reputationService } from '../services/reputation.service';
import { logger } from '../utils/logger';

const USAGE = 'Usage: revoke-account-verification <username|id>... [--confirm]';

interface Target {
  id: string;
  username: string | null;
  verified: boolean;
}

interface Report {
  revoked: Array<{ id: string; username: string | null; trustTier?: string }>;
  alreadyUnverified: Array<{ id: string; username: string | null }>;
  refused: Array<{ identifier: string; reason: string }>;
}

async function run(identifiers: readonly string[], confirm: boolean): Promise<Report> {
  const report: Report = { revoked: [], alreadyUnverified: [], refused: [] };
  const targets: Target[] = [];

  for (const identifier of identifiers) {
    const matches = await getDb()
      .select({
        id: users.id,
        username: users.username,
        kind: users.kind,
        verified: users.verified,
      })
      .from(users)
      .where(or(eq(users.id, identifier), sql`lower(${users.username}) = lower(${identifier})`))
      .limit(2);

    if (matches.length !== 1) {
      report.refused.push({
        identifier,
        reason: matches.length === 0 ? 'no such account' : 'names more than one account',
      });
    } else if (matches[0].kind === 'personal') {
      report.refused.push({ identifier, reason: 'a personal account is verified by personhood' });
    } else {
      targets.push(matches[0]);
    }
  }

  if (report.refused.length > 0) return report;

  for (const target of targets) {
    if (!target.verified) {
      report.alreadyUnverified.push({ id: target.id, username: target.username });
      continue;
    }
    if (!confirm) {
      report.revoked.push({ id: target.id, username: target.username });
      continue;
    }
    await getDb().update(users).set({ verified: false }).where(eq(users.id, target.id));
    const balance = await reputationService.recalculateBalance(target.id);
    report.revoked.push({ id: target.id, username: target.username, trustTier: balance.trustTier });
  }

  return report;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const confirm = argv.includes('--confirm');
  const identifiers = argv.filter((arg) => arg !== '--confirm').map((arg) => arg.trim());
  const unknown = identifiers.find((arg) => arg.startsWith('-'));
  if (unknown) throw new Error(`Unknown option ${unknown}. ${USAGE}`);
  if (identifiers.length === 0) throw new Error(USAGE);

  await connectPostgres();
  try {
    const report = await run(identifiers, confirm);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.refused.length > 0) {
      process.stdout.write('Refused: nothing was changed.\n');
      process.exitCode = 1;
    } else if (!confirm) {
      process.stdout.write('Dry run: nothing was changed. Re-run with --confirm to write.\n');
    }
  } finally {
    await closePostgres();
    await closeRedis();
  }
}

main()
  .catch((error: unknown) => {
    logger.error(
      '[revoke-account-verification] failed',
      error instanceof Error ? error : new Error(String(error)),
    );
    process.exitCode = 1;
  })
  .finally(() => {
    // A lingering handle (a cache client) must not keep a one-off task alive.
    process.exit();
  });
