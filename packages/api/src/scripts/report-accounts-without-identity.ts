#!/usr/bin/env bun
/**
 * Report personal accounts that have no identity key (phase 2 of "one
 * identity, two carriers", revised by ADR 0030).
 *
 * An account with `users.public_key IS NULL` signs in with its email (a code
 * or link, a password, an authenticator) but owns no identity: it cannot sign
 * anything and has no recovery phrase until it links Commons. This script
 * MEASURES that population. It is read-only by construction — an identity can
 * only be created by its owner, on their device.
 *
 * Only `type = 'local'`, `kind = 'personal'` accounts are counted: federated,
 * agent and managed accounts never sign in with an email. Output: totals, a
 * split by how a key-less account can sign in, and — with `SAMPLE` — a handful
 * of ids per bucket, NEWEST first. `noSignIn` (no key and no email) is the
 * bucket to act on: such an account has no way in at all. No usernames, no
 * emails, no IPs.
 *
 * Run (inside the oxy-api image, working dir /app):
 *   node packages/api/dist/scripts/report-accounts-without-identity.js
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
  /** No key, an email: signs in with it. */
  emailOnly: number;
  /** No key and no email: nothing to sign in with. */
  noSignIn: number;
  /**
   * No `users.public_key` but a linked `identity` auth method — an
   * inconsistency, not a population: something linked a key and did not write
   * it back.
   */
  linkedKeyMissing: number;
  /** Up to `SAMPLE` ids per bucket, newest first. Empty unless `SAMPLE` is set. */
  samples: { emailOnly: string[]; noSignIn: string[]; linkedKeyMissing: string[] };
}

type Bucket = 'emailOnly' | 'noSignIn' | 'linkedKeyMissing';

export async function reportAccountsWithoutIdentity(sampleSize = 0): Promise<IdentityGapReport> {
  const db = getDb();

  const [totals] = await db.execute<{ total: string; with_identity: string }>(sql`
    select count(*)::text as total,
           count(*) filter (where public_key is not null)::text as with_identity
      from users
     where type = 'local' and kind = 'personal'
  `);

  // One pass over the key-less accounts, bucketed by what they can sign in with.
  const rows = await db.execute<{ bucket: Bucket; count: string; sample: string[] }>(sql`
    with gap as (
      select u.id,
             u.created_at,
             nullif(btrim(u.email), '') is not null as has_email,
             exists (select 1 from user_auth_methods m where m.user_id = u.id and m.type = 'identity') as has_identity_method
        from users u
       where u.public_key is null and u.type = 'local' and u.kind = 'personal'
    )
    select case when has_identity_method then 'linkedKeyMissing'
                when has_email then 'emailOnly'
                else 'noSignIn' end as bucket,
           count(*)::text as count,
           (array_agg(id order by created_at desc, id desc))[1:${sql.raw(String(Math.max(0, Math.trunc(sampleSize))))}] as sample
      from gap
     group by 1
  `);

  const report: IdentityGapReport = {
    totalUsers: Number(totals?.total ?? 0),
    withIdentity: Number(totals?.with_identity ?? 0),
    withoutIdentity: 0,
    emailOnly: 0,
    noSignIn: 0,
    linkedKeyMissing: 0,
    samples: { emailOnly: [], noSignIn: [], linkedKeyMissing: [] },
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
