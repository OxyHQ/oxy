#!/usr/bin/env bun
/**
 * Census of personal roots and their holders (ADR 0024, #1302) — the migration
 * classes in `docs/identity/holders-and-recovery.md`, counted.
 *
 * Read-only by construction and AGGREGATE ONLY: counts per class, never an id,
 * username, key or ciphertext. It answers "who still needs what" before a
 * migration step ships and after it lands: how many personal accounts have no
 * root, how many roots have a web holder and of which envelope version and
 * secret kind, how many holders have proven they open the root, how many phrases
 * are saved or were shown to recover, how many envelopes seal a root the account
 * no longer has, and how many transfers are mid-flight.
 *
 * Run (inside the oxy-api image, working dir /app, or against a read-only replica):
 *   bun run packages/api/src/scripts/report-identity-holder-classes.ts
 */

import { sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../config/postgres';
import { logger } from '../utils/logger';

export interface IdentityHolderCensus {
  accounts: {
    personal: number;
    /** Organization, project and other managed kinds: not personal roots. */
    managed: number;
    /** Federated/automation rows among personal kinds (`users.type` other than `local`). */
    nonLocalPersonal: number;
  };
  /** Local personal accounts only. */
  roots: {
    linked: number;
    keylessWithPasskey: number;
    keylessWithoutMethod: number;
  };
  webHolders: {
    total: number;
    envelopeV1: number;
    envelopeV2Mnemonic: number;
    envelopeV2RawKey: number;
    /** Envelopes whose sealed root is no longer the account's (unreadable by design). */
    staleRoot: number;
    singleWrap: number;
    multipleWraps: number;
    /** Envelopes where at least one wrap proved it opens the root. */
    withVerifiedWrap: number;
    phraseConfirmed: number;
    recoveryVerified: number;
  };
  /** Linked roots with no current web holder: kept in Commons, or holder location unknown. */
  rootsWithoutWebHolder: number;
  transfers: { inFlightV1: number; inFlightV2: number };
}

function n(value: unknown): number {
  return Number(value ?? 0);
}

export async function reportIdentityHolderClasses(): Promise<IdentityHolderCensus> {
  const db = getDb();

  const [accounts] = await db.execute<Record<string, string>>(sql`
    select count(*) filter (where kind = 'personal')::text as personal,
           count(*) filter (where kind <> 'personal')::text as managed,
           count(*) filter (where kind = 'personal' and type <> 'local')::text as non_local_personal,
           count(*) filter (where kind = 'personal' and type = 'local' and public_key is not null)::text as linked
      from users
  `);

  const [keyless] = await db.execute<Record<string, string>>(sql`
    with gap as (
      select u.id, count(m.id) filter (where m.type = 'webauthn') as passkeys, count(m.id) as methods
        from users u
        left join user_auth_methods m on m.user_id = u.id
       where u.kind = 'personal' and u.type = 'local' and u.public_key is null
       group by u.id
    )
    select count(*) filter (where passkeys > 0)::text as with_passkey,
           count(*) filter (where methods = 0)::text as without_method
      from gap
  `);

  const [holders] = await db.execute<Record<string, string>>(sql`
    select count(*)::text as total,
           count(*) filter (where e.version = 1)::text as v1,
           count(*) filter (where e.version = 2 and e.secret_kind = 'mnemonic-entropy')::text as v2_mnemonic,
           count(*) filter (where e.version = 2 and e.secret_kind = 'raw-private-key')::text as v2_raw,
           count(*) filter (where u.public_key is null or lower(btrim(u.public_key)) <> e.public_key)::text as stale,
           count(*) filter (where jsonb_array_length(e.wraps) = 1)::text as single_wrap,
           count(*) filter (where jsonb_array_length(e.wraps) > 1)::text as multiple_wraps,
           count(*) filter (where exists (select 1 from jsonb_array_elements(e.wraps) w where w ? 'verifiedAt'))::text as verified_wrap,
           count(*) filter (where e.phrase_confirmed_at is not null)::text as phrase_confirmed,
           count(*) filter (where e.recovery_verified_at is not null)::text as recovery_verified
      from identity_web_envelopes e
      join users u on u.id = e.user_id
  `);

  const [withoutHolder] = await db.execute<Record<string, string>>(sql`
    select count(*)::text as count
      from users u
     where u.kind = 'personal' and u.public_key is not null
       and not exists (
         select 1 from identity_web_envelopes e
          where e.user_id = u.id and e.public_key = lower(btrim(u.public_key))
       )
  `);

  const [transfers] = await db.execute<Record<string, string>>(sql`
    select count(*) filter (where protocol_version = 1)::text as v1,
           count(*) filter (where protocol_version = 2)::text as v2
      from identity_moves
     where status in ('pending', 'joined', 'sealed') and expires_at > now()
  `);

  return {
    accounts: { personal: n(accounts?.personal), managed: n(accounts?.managed), nonLocalPersonal: n(accounts?.non_local_personal) },
    roots: { linked: n(accounts?.linked), keylessWithPasskey: n(keyless?.with_passkey), keylessWithoutMethod: n(keyless?.without_method) },
    webHolders: {
      total: n(holders?.total),
      envelopeV1: n(holders?.v1),
      envelopeV2Mnemonic: n(holders?.v2_mnemonic),
      envelopeV2RawKey: n(holders?.v2_raw),
      staleRoot: n(holders?.stale),
      singleWrap: n(holders?.single_wrap),
      multipleWraps: n(holders?.multiple_wraps),
      withVerifiedWrap: n(holders?.verified_wrap),
      phraseConfirmed: n(holders?.phrase_confirmed),
      recoveryVerified: n(holders?.recovery_verified),
    },
    rootsWithoutWebHolder: n(withoutHolder?.count),
    transfers: { inFlightV1: n(transfers?.v1), inFlightV2: n(transfers?.v2) },
  };
}

async function main(): Promise<void> {
  await connectPostgres();
  try {
    const census = await reportIdentityHolderClasses();
    logger.info('[identity-holders] census', { ...census });
    process.stdout.write(`${JSON.stringify(census, null, 2)}\n`);
  } finally {
    await closePostgres();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    logger.error('[identity-holders] failed', error);
    process.exitCode = 1;
  });
}
