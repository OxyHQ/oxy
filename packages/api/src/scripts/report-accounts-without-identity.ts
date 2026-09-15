#!/usr/bin/env bun
/**
 * Report accounts that have no identity key (phase 2 of "one identity, two
 * carriers": `docs/superpowers/specs/2026-09-15-one-identity-two-carriers-design.md`).
 *
 * An account with `users.public_key IS NULL` can sign in but owns no identity:
 * it cannot sign anything, cannot be moved to Commons, and has no recovery
 * phrase. This script MEASURES that population so the prompt to create one on
 * `id.oxy.so` can be aimed and its effect watched. It is read-only by
 * construction — there is nothing to write, because an identity can only be
 * created by its owner, on their device.
 *
 * Output: totals, a split by which auth methods the account has (passkey-only
 * accounts are the ones the sign-in prompt reaches), and — with `SAMPLE` — a
 * handful of ids to spot-check, NEWEST first, because a
 * gap among accounts created today says something different from a gap among
 * accounts created before the identity existed. No usernames, no emails, no IPs.
 *
 * Run (inside the oxy-api image, working dir /app):
 *   bun run packages/api/src/scripts/report-accounts-without-identity.ts
 *
 * Env:
 *   DATABASE_URL   Postgres connection string (required, injected by ECS from SSM)
 *   SAMPLE         How many user ids to print per bucket (default 0)
 */

import { sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../config/postgres';
import { logger } from '../utils/logger';

export interface IdentityGapReport {
  totalUsers: number;
  withIdentity: number;
  withoutIdentity: number;
  /** Accounts with no key whose auth methods are passkeys — reachable by the sign-in prompt. */
  passkeyOnly: number;
  /** Accounts with no key and no auth method at all (e.g. key-less legacy rows). */
  noAuthMethod: number;
  /**
   * Accounts with no `users.public_key` that nevertheless carry a linked
   * `identity` auth method — an inconsistency, not a population to prompt:
   * something linked a key and did not write it back.
   */
  linkedKeyMissing: number;
  /** Up to `SAMPLE` ids per bucket, newest first. Empty unless `SAMPLE` is set. */
  samples: { passkeyOnly: string[]; noAuthMethod: string[]; linkedKeyMissing: string[] };
}

type Bucket = 'passkeyOnly' | 'noAuthMethod' | 'linkedKeyMissing';

export async function reportAccountsWithoutIdentity(sampleSize = 0): Promise<IdentityGapReport> {
  const db = getDb();

  const [totals] = await db.execute<{ total: string; with_identity: string }>(sql`
    select count(*)::text as total,
           count(*) filter (where public_key is not null)::text as with_identity
      from users
  `);

  // One pass over the key-less accounts, bucketed by what they can sign in with.
  const rows = await db.execute<{ bucket: Bucket; count: string; sample: string[] }>(sql`
    with gap as (
      select u.id,
             u.created_at,
             coalesce(bool_or(m.type = 'identity'), false) as has_identity_method,
             count(m.id) as methods
        from users u
        left join user_auth_methods m on m.user_id = u.id
       where u.public_key is null
       group by u.id, u.created_at
    )
    select case when methods = 0 then 'noAuthMethod'
                when has_identity_method then 'linkedKeyMissing'
                else 'passkeyOnly' end as bucket,
           count(*)::text as count,
           (array_agg(id order by created_at desc, id desc))[1:${sql.raw(String(Math.max(0, Math.trunc(sampleSize))))}] as sample
      from gap
     group by 1
  `);

  const report: IdentityGapReport = {
    totalUsers: Number(totals?.total ?? 0),
    withIdentity: Number(totals?.with_identity ?? 0),
    withoutIdentity: 0,
    passkeyOnly: 0,
    noAuthMethod: 0,
    linkedKeyMissing: 0,
    samples: { passkeyOnly: [], noAuthMethod: [], linkedKeyMissing: [] },
  };
  for (const row of rows) {
    const count = Number(row.count);
    report[row.bucket] = count;
    report.withoutIdentity += count;
    report.samples[row.bucket] = row.sample ?? [];
  }
  return report;
}

async function main(): Promise<void> {
  await connectPostgres();
  try {
    const report = await reportAccountsWithoutIdentity(Number(process.env.SAMPLE) || 0);
    logger.info('[identity-gap] accounts without an identity key', { ...report });
    // Also on stdout, so a one-shot ECS task's logs read without a log driver.
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await closePostgres();
  }
}

// Guarded so the report itself can be exercised by tests without the runner
// opening (and closing) the pool underneath them.
if (require.main === module) {
  main().catch((error: unknown) => {
    logger.error('[identity-gap] failed', error);
    process.exitCode = 1;
  });
}
