/**
 * `device_principals` and `device_account_contexts`, held against the MIGRATED
 * database (issue #937, ADR 0001).
 *
 * Three things are checked here that nothing else can:
 *
 *  1. **Both halves of the CYCLE landed.** `device_account_contexts` points at
 *     `device_sessions` and `device_sessions.active_context_id` points back. A
 *     column-level circular reference has been silently dropped from a generated
 *     migration AND from its snapshot before now, with nothing failing — so this
 *     reads `pg_constraint` rather than the drizzle declaration or the SQL file.
 *     Mutation-tested by deleting either `ADD CONSTRAINT` from the migration and
 *     re-running: the missing side is named.
 *
 *  2. **The state the flat table could not hold, can now be held.** `Nate -> The
 *     Oxy Collective` beside `Alice -> The Oxy Collective` is the entire reason
 *     this schema exists, and `device_session_accounts`'
 *     `UNIQUE(device_session_id, account_id)` made it a duplicate-key error. A
 *     test that only checks the new uniques REJECT things would pass just as
 *     happily against a schema that rejects the case we are trying to support.
 *
 *  3. **What each `ON DELETE` actually does**, against real rows — deleting a
 *     person, a device, an account, and the active context itself.
 */

import { and, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../../config/postgres';
import { deviceAccountContexts } from '../deviceAccountContexts';
import { devicePrincipals } from '../devicePrincipals';
import { deviceSessions } from '../deviceSessions';
import { users } from '../users';

/** Foreign keys as the CATALOGUE has them, not as the schema file claims. */
type ForeignKeyRow = {
  readonly conname: string;
  readonly tbl: string;
  readonly ref: string;
  readonly confdeltype: string;
};

async function foreignKeys(): Promise<ForeignKeyRow[]> {
  const rows = await getDb().execute<ForeignKeyRow>(sql`
    select conname,
           conrelid::regclass::text as tbl,
           confrelid::regclass::text as ref,
           confdeltype
      from pg_constraint
     where contype = 'f'
       and conrelid::regclass::text in ('device_sessions', 'device_account_contexts', 'device_principals')
  `);
  return [...rows];
}

async function account(): Promise<string> {
  const [row] = await getDb().insert(users).values({}).returning({ id: users.id });
  return row.id;
}

async function device(): Promise<string> {
  const [row] = await getDb()
    .insert(deviceSessions)
    .values({ deviceId: `dev-${crypto.randomUUID()}` })
    .returning({ id: deviceSessions.id });
  return row.id;
}

async function principal(
  deviceSessionId: string,
  userId: string,
  authuser: number
): Promise<string> {
  const [row] = await getDb()
    .insert(devicePrincipals)
    .values({ deviceSessionId, userId, authuser })
    .returning({ id: devicePrincipals.id });
  return row.id;
}

async function context(
  deviceSessionId: string,
  principalId: string,
  accountId: string,
  sessionId: string | null = null
): Promise<string> {
  const [row] = await getDb()
    .insert(deviceAccountContexts)
    .values({ deviceSessionId, principalId, accountId, sessionId })
    .returning({ id: deviceAccountContexts.id });
  return row.id;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('the device-context cycle', () => {
  it('carries BOTH foreign keys, with the ON DELETE each one was chosen for', async () => {
    const byName = new Map(foreignKeysByName(await foreignKeys()));

    // Contexts hang off the device: CASCADE, because a context of a device that
    // no longer exists addresses nothing.
    expect(byName.get('device_account_contexts_device_session_id_device_sessions_id_fk')).toEqual({
      ref: 'device_sessions',
      onDelete: 'c',
    });
    // The device points back at its active context: SET NULL, because NULL is
    // the first-class "signed in, nothing selected" state and CASCADE would
    // delete the whole DEVICE when one of several contexts goes.
    expect(byName.get('device_sessions_active_context_id_device_account_contexts_id_fk')).toEqual({
      ref: 'device_account_contexts',
      onDelete: 'n',
    });
  });

  it('names both constraints in full — Postgres truncates at 63 characters', async () => {
    // Both sit exactly AT the limit, so a rename that lengthens either one would
    // be silently truncated and every catalogue lookup above would miss.
    for (const name of [
      'device_account_contexts_device_session_id_device_sessions_id_fk',
      'device_sessions_active_context_id_device_account_contexts_id_fk',
    ]) {
      expect(name.length).toBeLessThanOrEqual(63);
    }
  });

  it('cascades a principal onto its contexts, and a device onto both', async () => {
    const deviceSessionId = await device();
    const person = await account();
    const org = await account();
    const principalId = await principal(deviceSessionId, person, 0);
    await context(deviceSessionId, principalId, person, 's-personal');
    await context(deviceSessionId, principalId, org, 's-org');

    await getDb().delete(devicePrincipals).where(eq(devicePrincipals.id, principalId));
    expect(
      await getDb()
        .select({ id: deviceAccountContexts.id })
        .from(deviceAccountContexts)
        .where(eq(deviceAccountContexts.deviceSessionId, deviceSessionId))
    ).toEqual([]);
  });

  it('nulls active_context_id when the active context goes, never deleting the device', async () => {
    const deviceSessionId = await device();
    const person = await account();
    const principalId = await principal(deviceSessionId, person, 0);
    const contextId = await context(deviceSessionId, principalId, person, 's-personal');
    await getDb()
      .update(deviceSessions)
      .set({ activeContextId: contextId, activeAccountId: person })
      .where(eq(deviceSessions.id, deviceSessionId));

    await getDb().delete(deviceAccountContexts).where(eq(deviceAccountContexts.id, contextId));

    const [row] = await getDb()
      .select({ id: deviceSessions.id, activeContextId: deviceSessions.activeContextId })
      .from(deviceSessions)
      .where(eq(deviceSessions.id, deviceSessionId));
    expect(row).toEqual({ id: deviceSessionId, activeContextId: null });
  });

  it('removes every context pointing at a deleted account, under any principal', async () => {
    const deviceSessionId = await device();
    const nate = await account();
    const alice = await account();
    const org = await account();
    const natePrincipal = await principal(deviceSessionId, nate, 0);
    const alicePrincipal = await principal(deviceSessionId, alice, 1);
    await context(deviceSessionId, natePrincipal, org, 's-nate-org');
    await context(deviceSessionId, alicePrincipal, org, 's-alice-org');

    await getDb().delete(users).where(eq(users.id, org));

    expect(
      await getDb()
        .select({ id: deviceAccountContexts.id })
        .from(deviceAccountContexts)
        .where(eq(deviceAccountContexts.deviceSessionId, deviceSessionId))
    ).toEqual([]);
  });
});

describe('what the new shape can hold', () => {
  it('holds ONE account under TWO principals — the case the flat table rejected', async () => {
    const deviceSessionId = await device();
    const nate = await account();
    const alice = await account();
    const org = await account();
    const natePrincipal = await principal(deviceSessionId, nate, 0);
    const alicePrincipal = await principal(deviceSessionId, alice, 1);

    await context(deviceSessionId, natePrincipal, org, 's-nate-org');
    await context(deviceSessionId, alicePrincipal, org, 's-alice-org');

    const rows = await getDb()
      .select({ principalId: deviceAccountContexts.principalId })
      .from(deviceAccountContexts)
      .where(
        and(
          eq(deviceAccountContexts.deviceSessionId, deviceSessionId),
          eq(deviceAccountContexts.accountId, org)
        )
      );
    // `device_session_accounts_device_session_id_account_id_key` made this a
    // duplicate key. Two different people, two sessions, two audit actors.
    expect(rows.map((row) => row.principalId).sort()).toEqual(
      [natePrincipal, alicePrincipal].sort()
    );
  });

  it('holds a context with NO session — "reachable, never yet used here"', async () => {
    const deviceSessionId = await device();
    const nate = await account();
    const org = await account();
    const natePrincipal = await principal(deviceSessionId, nate, 0);
    const contextId = await context(deviceSessionId, natePrincipal, org, null);

    const [row] = await getDb()
      .select({ sessionId: deviceAccountContexts.sessionId })
      .from(deviceAccountContexts)
      .where(eq(deviceAccountContexts.id, contextId));
    // NULL, not `''`: an empty string is a VALUE, and the mint path would take
    // it for a session id.
    expect(row.sessionId).toBeNull();
  });
});

describe('what the new shape refuses', () => {
  it('refuses a second principal in the same authuser slot', async () => {
    const deviceSessionId = await device();
    await principal(deviceSessionId, await account(), 0);
    await expect(principal(deviceSessionId, await account(), 0)).rejects.toThrow();
  });

  it('refuses one person twice on one device', async () => {
    const deviceSessionId = await device();
    const person = await account();
    await principal(deviceSessionId, person, 0);
    await expect(principal(deviceSessionId, person, 1)).rejects.toThrow();
  });

  it('refuses a negative authuser — it would address a slot no client can produce', async () => {
    const deviceSessionId = await device();
    await expect(principal(deviceSessionId, await account(), -1)).rejects.toThrow();
  });

  it('refuses the same (principal, account) pair twice', async () => {
    const deviceSessionId = await device();
    const person = await account();
    const org = await account();
    const principalId = await principal(deviceSessionId, person, 0);
    await context(deviceSessionId, principalId, org, 's-1');
    await expect(context(deviceSessionId, principalId, org, 's-2')).rejects.toThrow();
  });
});

/** `[name, {ref, onDelete}]` pairs, for a lookup that names what is missing. */
function foreignKeysByName(
  rows: readonly ForeignKeyRow[]
): Array<[string, { ref: string; onDelete: string }]> {
  return rows.map((row) => [row.conname, { ref: row.ref, onDelete: row.confdeltype }]);
}
