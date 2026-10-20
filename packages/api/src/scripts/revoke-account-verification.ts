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

import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../config/postgres';
import { closeRedis } from '../config/redis';
import { users } from '../db/schema/users';
import { reputationService } from '../services/reputation.service';
import { logger } from '../utils/logger';
import { resolveOperatorAccount } from '../utils/resolveUserIdentifier';

const USAGE = 'Usage: revoke-account-verification <username|id>... [--confirm]';

interface Report {
  /** With `--confirm`, each entry also carries the trust tier it dropped to. */
  toRevoke: Array<{ id: string; username: string | null; trustTier?: string }>;
  alreadyUnverified: Array<{ id: string; username: string | null }>;
  refused: Array<{ identifier: string; reason: string }>;
}

async function run(identifiers: readonly string[], confirm: boolean): Promise<Report> {
  const report: Report = { toRevoke: [], alreadyUnverified: [], refused: [] };
  const seen = new Set<string>();

  for (const identifier of identifiers) {
    const resolved = await resolveOperatorAccount(identifier);
    if ('reason' in resolved) {
      report.refused.push({ identifier, reason: resolved.reason });
      continue;
    }
    const { account } = resolved;
    if (seen.has(account.id)) continue;
    seen.add(account.id);

    if (account.kind === 'personal') {
      report.refused.push({ identifier, reason: 'a personal account is verified by personhood' });
    } else {
      const entry = { id: account.id, username: account.username };
      (account.verified ? report.toRevoke : report.alreadyUnverified).push(entry);
    }
  }

  if (report.refused.length > 0 || !confirm) return report;

  for (const entry of report.toRevoke) {
    await getDb().update(users).set({ verified: false }).where(eq(users.id, entry.id));
    entry.trustTier = (await reputationService.recalculateBalance(entry.id)).trustTier;
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
