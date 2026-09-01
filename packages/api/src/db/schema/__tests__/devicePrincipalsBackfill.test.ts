/**
 * Migration 0028's BACKFILL, run against a seeded corpus (issue #937, ADR 0001).
 *
 * The statements executed here are read out of
 * `drizzle/0028_device_principals_and_contexts.sql` and run verbatim. Copying
 * them into this file would test a copy: the migration could then be edited, or
 * regenerated, and this suite would go on proving something about SQL that no
 * longer ships.
 *
 * ## Why its own database
 *
 * The backfill statements are unscoped — they translate EVERY
 * `device_session_accounts` row and scan EVERY `device_principals` row, because
 * that is what a migration does. Run against the worker's shared database they
 * would evaluate whatever other suites left behind, so every count here would be
 * measuring other people's rows. The database is created, migrated, seeded and
 * dropped by this file alone.
 *
 * ## The corpus
 *
 * One device per class the backfill can meet, named for what it is testing. Two
 * of the six conflict classes are impossible while `device_session_accounts`
 * still has its own constraints; the last `describe` DROPS those constraints and
 * feeds each detection query a row it must find, because "found nothing" and
 * "cannot find anything" are otherwise the same answer.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import { DATABASE_CASING } from '@oxyhq/db';
import * as schema from '../index';
import { createTestDatabase, dropTestDatabase } from '../../testDatabase';
import { deviceSessionAccounts } from '../deviceSessionAccounts';
import { deviceSessions } from '../deviceSessions';
import { users } from '../users';

const MIGRATION = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'drizzle',
  '0028_device_principals_and_contexts.sql'
);

/**
 * The nine data statements at the end of the migration, in file order.
 *
 * A vacuity floor rather than a lower bound: this suite asserts on the effect of
 * each one, so a statement appearing or disappearing has to be a deliberate edit
 * here too.
 */
const BACKFILL_STATEMENT_COUNT = 9;

/** Every statement of the migration that writes DATA rather than DDL. */
function backfillStatements(): string[] {
  return readFileSync(MIGRATION, 'utf8')
    .split('--> statement-breakpoint')
    .filter((chunk) => {
      // Classify on the code, execute the whole chunk: the comments above each
      // statement are part of what ships and Postgres is happy to receive them.
      const code = chunk
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .trim();
      return code.startsWith('INSERT INTO') || code.startsWith('UPDATE ');
    })
    .map((chunk) => chunk.trim());
}

let databaseUrl: string;
let sql: Sql;
/**
 * Seeds go through drizzle, reads through the raw client.
 *
 * `users` has half a dozen application-supplied defaults (`id`, `color`, ...)
 * that a raw `INSERT` would have to enumerate and then keep in step with the
 * schema forever. The BACKFILL is still raw SQL out of the migration file —
 * that is the thing under test.
 */
let db: PostgresJsDatabase<typeof schema>;

/** A `users` row of a given account kind, returning its id. */
async function user(kind: 'personal' | 'organization'): Promise<string> {
  const [row] = await db.insert(users).values({ kind }).returning({ id: users.id });
  return row.id;
}

/** A `device_sessions` row, returning `{ id, deviceId }`. */
async function device(name: string): Promise<{ id: string; deviceId: string }> {
  const deviceId = `${name}-${randomUUID()}`;
  const [row] = await db
    .insert(deviceSessions)
    .values({ deviceId })
    .returning({ id: deviceSessions.id });
  return { id: row.id, deviceId };
}

/** A flat `device_session_accounts` entry, as the previous image wrote them. */
async function entry(input: {
  deviceSessionId: string;
  accountId: string;
  sessionId: string;
  authuser: number;
  operatedByUserId?: string;
  addedAt: Date;
}): Promise<void> {
  await db.insert(deviceSessionAccounts).values({
    deviceSessionId: input.deviceSessionId,
    accountId: input.accountId,
    sessionId: input.sessionId,
    authuser: input.authuser,
    operatedByUserId: input.operatedByUserId ?? null,
    addedAt: input.addedAt,
  });
}

type PrincipalRow = { user_id: string; authuser: number; personal_session_id: string | null };

async function principalsOf(deviceSessionId: string): Promise<PrincipalRow[]> {
  return sql<PrincipalRow[]>`
    select user_id, authuser, personal_session_id
      from device_principals
     where device_session_id = ${deviceSessionId}
     order by authuser
  `;
}

type ContextRow = { account_id: string; session_id: string | null; principal_user_id: string };

async function contextsOf(deviceSessionId: string): Promise<ContextRow[]> {
  return sql<ContextRow[]>`
    select c.account_id, c.session_id, p.user_id as principal_user_id
      from device_account_contexts c
      join device_principals p on p.id = c.principal_id
     where c.device_session_id = ${deviceSessionId}
     order by c.added_at, c.id
  `;
}

async function conflictsFor(deviceId: string): Promise<Array<{ conflict: string; subject_id: string }>> {
  return sql<Array<{ conflict: string; subject_id: string }>>`
    select conflict, subject_id from device_principal_backfill_conflicts
     where device_id = ${deviceId} order by conflict
  `;
}

/** Timestamps far enough apart that no ordering here depends on a tie-break. */
const T0 = new Date('2026-01-01T00:00:00.000Z');
const T1 = new Date('2026-01-02T00:00:00.000Z');

/** Every device of the corpus, filled in by `beforeAll`. */
const corpus: Record<string, { id: string; deviceId: string }> = {};
const actor: Record<string, string> = {};

beforeAll(async () => {
  databaseUrl = await createTestDatabase({ assignEnv: false });
  sql = postgres(databaseUrl, { max: 1 });
  db = drizzle(sql, { schema, casing: DATABASE_CASING });

  // --- personal: two ordinary people, nothing delegated ---------------------
  corpus.personal = await device('personal');
  actor.p1 = await user('personal');
  actor.p2 = await user('personal');
  await entry({ deviceSessionId: corpus.personal.id, accountId: actor.p1, sessionId: 's-p1', authuser: 0, addedAt: T0 });
  await entry({ deviceSessionId: corpus.personal.id, accountId: actor.p2, sessionId: 's-p2', authuser: 1, addedAt: T1 });
  await sql`update device_sessions set active_account_id = ${actor.p2} where id = ${corpus.personal.id}`;

  // --- delegated: a person, and an organization they operate ----------------
  corpus.delegated = await device('delegated');
  actor.operator = await user('personal');
  actor.org = await user('organization');
  await entry({ deviceSessionId: corpus.delegated.id, accountId: actor.operator, sessionId: 's-op', authuser: 0, addedAt: T0 });
  await entry({ deviceSessionId: corpus.delegated.id, accountId: actor.org, sessionId: 's-org', authuser: 1, operatedByUserId: actor.operator, addedAt: T1 });
  await sql`update device_sessions set active_account_id = ${actor.org} where id = ${corpus.delegated.id}`;

  // --- operatorOnly: the operator was never signed in here as themselves ----
  corpus.operatorOnly = await device('operator-only');
  actor.absentOperator = await user('personal');
  actor.org2 = await user('organization');
  await entry({ deviceSessionId: corpus.operatorOnly.id, accountId: actor.org2, sessionId: 's-org2', authuser: 0, operatedByUserId: actor.absentOperator, addedAt: T0 });
  await sql`update device_sessions set active_account_id = ${actor.org2} where id = ${corpus.operatorOnly.id}`;

  // --- orgPrincipal: a legacy entry for an org with no operator recorded -----
  corpus.orgPrincipal = await device('org-principal');
  actor.org3 = await user('organization');
  await entry({ deviceSessionId: corpus.orgPrincipal.id, accountId: actor.org3, sessionId: 's-org3', authuser: 0, addedAt: T0 });

  // --- ghostActive: active_account_id names an account with no entry --------
  corpus.ghostActive = await device('ghost-active');
  actor.present = await user('personal');
  actor.ghost = await user('personal');
  await entry({ deviceSessionId: corpus.ghostActive.id, accountId: actor.present, sessionId: 's-present', authuser: 0, addedAt: T0 });
  await sql`update device_sessions set active_account_id = ${actor.ghost} where id = ${corpus.ghostActive.id}`;

  // --- slotClash: two people at authuser 0, which the flat table permitted ---
  corpus.slotClash = await device('slot-clash');
  actor.early = await user('personal');
  actor.late = await user('personal');
  await entry({ deviceSessionId: corpus.slotClash.id, accountId: actor.early, sessionId: 's-early', authuser: 0, addedAt: T0 });
  await entry({ deviceSessionId: corpus.slotClash.id, accountId: actor.late, sessionId: 's-late', authuser: 0, addedAt: T1 });

  // --- personalSlotAbove: the person's OWN slot is higher than the org's ----
  // A device with a long enough sign-in/out history can leave a delegated entry
  // holding a lower number than its operator's personal one. The person's slot
  // is theirs, not the lowest number they appear on.
  corpus.personalSlotAbove = await device('personal-slot-above');
  actor.xp = await user('personal');
  actor.xorg = await user('organization');
  await entry({ deviceSessionId: corpus.personalSlotAbove.id, accountId: actor.xorg, sessionId: 's-x-org', authuser: 0, operatedByUserId: actor.xp, addedAt: T0 });
  await entry({ deviceSessionId: corpus.personalSlotAbove.id, accountId: actor.xp, sessionId: 's-xp', authuser: 1, addedAt: T1 });

  // --- gap: slot 1 was freed by a sign-out and must stay free ---------------
  corpus.gap = await device('gap');
  actor.g0 = await user('personal');
  actor.g2 = await user('personal');
  await entry({ deviceSessionId: corpus.gap.id, accountId: actor.g0, sessionId: 's-g0', authuser: 0, addedAt: T0 });
  await entry({ deviceSessionId: corpus.gap.id, accountId: actor.g2, sessionId: 's-g2', authuser: 2, addedAt: T1 });

  const statements = backfillStatements();
  if (statements.length !== BACKFILL_STATEMENT_COUNT) {
    throw new Error(
      `Expected ${BACKFILL_STATEMENT_COUNT} data statements in 0028, found ${statements.length}. ` +
        'Either the migration changed or the classifier stopped recognising it — ' +
        'a suite that runs zero statements passes by examining nothing.'
    );
  }
  for (const statement of statements) {
    await sql.unsafe(statement);
  }
}, 60_000);

afterAll(async () => {
  await sql?.end();
  if (databaseUrl) await dropTestDatabase(databaseUrl);
}, 60_000);

describe('an ordinary all-personal device', () => {
  it('becomes one principal per person, keeping both slots and both sessions', async () => {
    expect(await principalsOf(corpus.personal.id)).toEqual([
      { user_id: actor.p1, authuser: 0, personal_session_id: 's-p1' },
      { user_id: actor.p2, authuser: 1, personal_session_id: 's-p2' },
    ]);
  });

  it('gives each principal its own personal context, carrying the session verbatim', async () => {
    expect(await contextsOf(corpus.personal.id)).toEqual([
      { account_id: actor.p1, session_id: 's-p1', principal_user_id: actor.p1 },
      { account_id: actor.p2, session_id: 's-p2', principal_user_id: actor.p2 },
    ]);
  });

  it('points active_context_id at the active account\'s context', async () => {
    const [row] = await sql`
      select c.account_id from device_sessions ds
        join device_account_contexts c on c.id = ds.active_context_id
       where ds.id = ${corpus.personal.id}
    `;
    expect(row.account_id).toBe(actor.p2);
  });

  it('reports nothing', async () => {
    expect(await conflictsFor(corpus.personal.deviceId)).toEqual([]);
  });
});

describe('a person operating an organization', () => {
  it('produces ONE principal — the org stops consuming a human slot', async () => {
    expect(await principalsOf(corpus.delegated.id)).toEqual([
      { user_id: actor.operator, authuser: 0, personal_session_id: 's-op' },
    ]);
  });

  it('hangs both the personal and the delegated context off that one person', async () => {
    expect(await contextsOf(corpus.delegated.id)).toEqual([
      { account_id: actor.operator, session_id: 's-op', principal_user_id: actor.operator },
      { account_id: actor.org, session_id: 's-org', principal_user_id: actor.operator },
    ]);
  });

  it('elects the DELEGATED context when the org was the active account', async () => {
    const [row] = await sql`
      select c.account_id, p.user_id as principal_user_id
        from device_sessions ds
        join device_account_contexts c on c.id = ds.active_context_id
        join device_principals p on p.id = c.principal_id
       where ds.id = ${corpus.delegated.id}
    `;
    expect(row).toEqual({ account_id: actor.org, principal_user_id: actor.operator });
  });

  it('reports nothing — releasing the org\'s slot is the design, not a loss', async () => {
    expect(await conflictsFor(corpus.delegated.deviceId)).toEqual([]);
  });
});

describe('an operator who was never signed in here as themselves', () => {
  it('becomes a principal on the slot its delegated entry held', async () => {
    expect(await principalsOf(corpus.operatorOnly.id)).toEqual([
      { user_id: actor.absentOperator, authuser: 0, personal_session_id: null },
    ]);
  });

  it('gets NO invented personal context — the flat table never claimed one', async () => {
    expect(await contextsOf(corpus.operatorOnly.id)).toEqual([
      { account_id: actor.org2, session_id: 's-org2', principal_user_id: actor.absentOperator },
    ]);
  });

  it('is reported, because ADR 0001 requires a live principal to have one', async () => {
    expect(await conflictsFor(corpus.operatorOnly.deviceId)).toEqual([
      { conflict: 'principal_without_personal_context', subject_id: actor.absentOperator },
    ]);
  });
});

describe('a legacy entry whose principal is not a person', () => {
  it('is copied faithfully rather than dropped', async () => {
    expect(await contextsOf(corpus.orgPrincipal.id)).toEqual([
      { account_id: actor.org3, session_id: 's-org3', principal_user_id: actor.org3 },
    ]);
  });

  it('is reported — an organization is a subject, never a principal', async () => {
    // ONLY this class. The entry carried no operator, so it maps to the org
    // acting as ITSELF: a personal context, which is precisely the shape ADR
    // 0001 forbids and precisely why the row has to be named rather than
    // silently normalised into something defensible.
    expect(await conflictsFor(corpus.orgPrincipal.deviceId)).toEqual([
      { conflict: 'non_personal_principal', subject_id: actor.org3 },
    ]);
  });
});

describe('an active account with no entry to elect', () => {
  it('leaves active_context_id NULL rather than guessing', async () => {
    const [row] = await sql`
      select active_context_id from device_sessions where id = ${corpus.ghostActive.id}
    `;
    expect(row.active_context_id).toBeNull();
  });

  it('is reported', async () => {
    expect(await conflictsFor(corpus.ghostActive.deviceId)).toEqual([
      { conflict: 'active_account_without_context', subject_id: actor.ghost },
    ]);
  });
});

describe('two people claiming one authuser slot', () => {
  it('gives the slot to the earlier arrival and moves the later above every slot in use', async () => {
    expect(await principalsOf(corpus.slotClash.id)).toEqual([
      { user_id: actor.early, authuser: 0, personal_session_id: 's-early' },
      { user_id: actor.late, authuser: 1, personal_session_id: 's-late' },
    ]);
  });

  it('reports the one that moved, and only that one', async () => {
    expect(await conflictsFor(corpus.slotClash.deviceId)).toEqual([
      { conflict: 'authuser_collapsed', subject_id: actor.late },
    ]);
  });
});

describe('a person whose own slot is above the organization they operate', () => {
  it('takes the slot from their PERSONAL entry, not the lowest one they appear on', async () => {
    expect(await principalsOf(corpus.personalSlotAbove.id)).toEqual([
      { user_id: actor.xp, authuser: 1, personal_session_id: 's-xp' },
    ]);
  });

  it('reports nothing', async () => {
    expect(await conflictsFor(corpus.personalSlotAbove.deviceId)).toEqual([]);
  });
});

describe('a device with a freed slot', () => {
  it('preserves both numbers exactly, gap included', async () => {
    // Densely renumbering would silently change a value clients put in URLs, on
    // a device that has nothing to do with organizations. The gap closes on its
    // own the next time somebody signs in here.
    expect(await principalsOf(corpus.gap.id)).toEqual([
      { user_id: actor.g0, authuser: 0, personal_session_id: 's-g0' },
      { user_id: actor.g2, authuser: 2, personal_session_id: 's-g2' },
    ]);
  });
});

describe('the corpus as a whole', () => {
  it('translated every entry, losing none and inventing none', async () => {
    const [counts] = await sql`
      select (select count(*)::int from device_session_accounts) as entries,
             (select count(*)::int from device_principals) as principals,
             (select count(*)::int from device_account_contexts) as contexts,
             (select count(*)::int from device_account_contexts where session_id is null) as sessionless,
             (select count(*)::int from device_principal_backfill_conflicts) as conflicts
    `;
    // 13 flat entries across 8 devices become 13 contexts — one each, nothing
    // dropped and nothing fabricated — carried by 11 people, because two
    // organizations stopped consuming a human slot.
    expect(counts).toEqual({
      entries: 13,
      principals: 11,
      contexts: 13,
      sessionless: 0,
      conflicts: 4,
    });
  });

  it('gives every context a live session — a flat entry always had one', async () => {
    const [row] = await sql`
      select count(*)::int as n from device_account_contexts c
        join device_session_accounts a
          on a.device_session_id = c.device_session_id and a.account_id = c.account_id
       where a.session_id is distinct from c.session_id
    `;
    expect(row.n).toBe(0);
  });
});

describe('the two checks whose answer is known', () => {
  it('found nothing, on a corpus where nothing could be found', async () => {
    const [row] = await sql`
      select count(*)::int as n from device_principal_backfill_conflicts
       where conflict in ('duplicate_principal_account', 'orphan_operator')
    `;
    expect(row.n).toBe(0);
  });

  // The positive control for the line above. Both classes are unreachable only
  // because `device_session_accounts` still carries the constraints that forbid
  // them — so the constraints come off, each query is fed a row it must find,
  // and the SAME statement out of the SAME migration is re-run. Without this,
  // "found nothing" and "the query matches nothing" read identically.
  it('finds them once the constraints that forbid them are gone', async () => {
    await sql.unsafe(`
      alter table device_session_accounts
        drop constraint device_session_accounts_device_session_id_account_id_key,
        drop constraint device_session_accounts_operated_by_user_id_users_id_fk
    `);

    const pathological = await device('pathological');
    const operator = await user('personal');
    const org = await user('organization');
    await entry({ deviceSessionId: pathological.id, accountId: org, sessionId: 's-a', authuser: 0, operatedByUserId: operator, addedAt: T0 });
    await entry({ deviceSessionId: pathological.id, accountId: org, sessionId: 's-b', authuser: 1, operatedByUserId: operator, addedAt: T1 });
    await entry({ deviceSessionId: pathological.id, accountId: await user('personal'), sessionId: 's-c', authuser: 2, operatedByUserId: 'no-such-user', addedAt: T1 });

    const [orphanCheck, duplicateCheck] = backfillStatements();
    await sql.unsafe(orphanCheck);
    await sql.unsafe(duplicateCheck);

    expect(await conflictsFor(pathological.deviceId)).toEqual([
      { conflict: 'duplicate_principal_account', subject_id: org },
      { conflict: 'orphan_operator', subject_id: 'no-such-user' },
    ]);
  });
});
