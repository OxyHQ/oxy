#!/usr/bin/env node
/**
 * Delete personal accounts by operator decision — the SAME workflow
 * `DELETE /users/me` runs (`services/accountDeletion.service.ts`): financial
 * holds first, then every optional datum, then the row deleted (or archived
 * when financial records must be kept), with the `account.deleted` event for
 * relying parties in the same transaction.
 *
 * For accounts whose owner cannot delete them from the app — e.g. the
 * passkey-only test accounts left with no way to sign in once passkeys were
 * removed (ADR 0030). The owner's approval is the operator's responsibility;
 * this script only enforces what it may touch:
 *
 * - each argument is a username (case-insensitive) or an account id, and must
 *   name exactly one account;
 * - only `type = 'local'`, `kind = 'personal'`, `account_status = 'active'`
 *   accounts — never a federated, agent, automated or managed account, and
 *   never one already closed;
 * - a live subscription, in-flight reservation or live BYOK connection refuses
 *   that account, as the route does;
 * - ANY refusal stops the whole run before anything is deleted.
 *
 * DRY-RUN BY DEFAULT: without `--confirm` it prints what it would do and
 * changes nothing. Output is JSON on stdout (ids, usernames, whether an email
 * or a key exists — never the email itself).
 *
 * Run (inside the oxy-api image, working dir /app, as a one-off ECS task on the
 * live task definition with only `command` overridden):
 *   node packages/api/dist/scripts/delete-accounts.js alice bob            # dry run
 *   node packages/api/dist/scripts/delete-accounts.js alice bob --confirm  # delete
 *
 * Env: DATABASE_URL (and the API's usual env: Redis, S3 for mailbox data).
 */

import { eq, or, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../config/postgres';
import { closeRedis } from '../config/redis';
import { users } from '../db/schema/users';
import { describeAccountFinancialHolds } from '../services/accountFinancialHolds.service';
import { assertAccountDeletable, deleteAccount, type AccountDeletionResult } from '../services/accountDeletion.service';
import { logger } from '../utils/logger';

export interface DeleteAccountsArgs {
  identifiers: string[];
  confirm: boolean;
}

/** `argv` without the node binary and script path. */
export function parseDeleteAccountsArgs(argv: readonly string[]): DeleteAccountsArgs {
  const identifiers: string[] = [];
  let confirm = false;
  for (const arg of argv) {
    if (arg === '--confirm') {
      confirm = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option ${arg}. Usage: delete-accounts <username|id>... [--confirm]`);
    } else if (arg.trim()) {
      identifiers.push(arg.trim());
    }
  }
  if (identifiers.length === 0) {
    throw new Error('Name at least one account. Usage: delete-accounts <username|id>... [--confirm]');
  }
  return { identifiers, confirm };
}

export interface PlannedDeletion {
  identifier: string;
  id: string;
  username: string | null;
  hasEmail: boolean;
  hasKey: boolean;
  /** `delete` removes the row; `archive` keeps it for retained financial records. */
  outcome: 'delete' | 'archive';
  retainedRecords: { table: string; column: string; rows: number }[];
}

export interface RefusedDeletion {
  identifier: string;
  reason: string;
}

export interface DeletionPlan {
  planned: PlannedDeletion[];
  refused: RefusedDeletion[];
}

/** Resolve and check every identifier. Reads only. */
export async function planAccountDeletions(identifiers: readonly string[]): Promise<DeletionPlan> {
  const planned: PlannedDeletion[] = [];
  const refused: RefusedDeletion[] = [];
  const seen = new Set<string>();

  for (const identifier of identifiers) {
    const matches = await getDb()
      .select({
        id: users.id,
        username: users.username,
        email: users.email,
        publicKey: users.publicKey,
        type: users.type,
        kind: users.kind,
        accountStatus: users.accountStatus,
      })
      .from(users)
      .where(or(eq(users.id, identifier), sql`lower(${users.username}) = lower(${identifier})`))
      .limit(2);

    if (matches.length !== 1) {
      refused.push({ identifier, reason: matches.length === 0 ? 'no such account' : 'names more than one account' });
      continue;
    }
    const [account] = matches;
    if (seen.has(account.id)) continue;
    seen.add(account.id);

    if (account.type !== 'local' || account.kind !== 'personal') {
      refused.push({ identifier, reason: `not a local personal account (type=${account.type}, kind=${account.kind})` });
      continue;
    }
    if (account.accountStatus !== 'active') {
      refused.push({ identifier, reason: `account is ${account.accountStatus}` });
      continue;
    }

    const holds = await describeAccountFinancialHolds(account.id);
    try {
      assertAccountDeletable(holds);
    } catch (error) {
      refused.push({ identifier, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }

    planned.push({
      identifier,
      id: account.id,
      username: account.username,
      hasEmail: Boolean(account.email?.trim()),
      hasKey: Boolean(account.publicKey),
      outcome: holds.blocksHardDelete ? 'archive' : 'delete',
      retainedRecords: holds.retainedRecords.map((record) => ({ ...record })),
    });
  }

  return { planned, refused };
}

export interface DeleteAccountsReport {
  confirm: boolean;
  plan: DeletionPlan;
  /** Only with `--confirm` and no refusal. */
  results: { id: string; username: string | null; result: AccountDeletionResult }[];
}

/**
 * Plan, and — only with `confirm` and nothing refused — delete each planned
 * account through the one deletion workflow.
 */
export async function runAccountDeletions(args: DeleteAccountsArgs): Promise<DeleteAccountsReport> {
  const plan = await planAccountDeletions(args.identifiers);
  const report: DeleteAccountsReport = { confirm: args.confirm, plan, results: [] };
  if (!args.confirm || plan.refused.length > 0) return report;

  for (const account of plan.planned) {
    const result = await deleteAccount(account.id, account.username);
    report.results.push({ id: account.id, username: account.username, result });
  }
  return report;
}

async function main(): Promise<void> {
  const args = parseDeleteAccountsArgs(process.argv.slice(2));
  await connectPostgres();
  try {
    const report = await runAccountDeletions(args);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.plan.refused.length > 0) {
      process.stdout.write('Refused: nothing was deleted.\n');
      process.exitCode = 1;
    } else if (!args.confirm) {
      process.stdout.write('Dry run: nothing was deleted. Re-run with --confirm to delete.\n');
    }
  } finally {
    await closePostgres();
    await closeRedis();
  }
}

// Guarded so the functions can be exercised by tests without the runner.
if (require.main === module) {
  main()
    .catch((error: unknown) => {
      logger.error('[delete-accounts] failed', error instanceof Error ? error : new Error(String(error)));
      process.exitCode = 1;
    })
    .finally(() => {
      // A lingering handle (a mail or cache client) must not keep a one-off task alive.
      process.exit();
    });
}
