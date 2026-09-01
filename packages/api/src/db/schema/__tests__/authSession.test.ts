/**
 * The auth/session cluster, against a REAL Postgres.
 *
 * Twelve tables carrying credentials, approvals and an audit trail, so the
 * assertions here are about the properties that would FAIL OPEN if they were
 * subtly wrong on port — not about column inventory, which `drizzle-kit` and
 * `tsc` already hold.
 *
 * Everything runs through the application's own pool against the throwaway
 * database `jest.globalSetup.ts` migrated: no mock, no second migrator. The run
 * shares one database, so every row carries a per-test random owner or handle
 * and no assertion depends on a table being empty.
 */

import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { getTableName } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../../config/postgres';
import { sqlColumnName } from '@oxyhq/db';
import { publicColumns } from '@oxyhq/db/assert';
import { sweepExpiredRows } from '@oxyhq/db/expiry';
import { EXPIRY_SWEEP_TARGETS } from '../../expiry';
import { applications } from '../applications';
import { authCodes } from '../authCodes';
import { authSessions } from '../authSessions';
import { civicNonces } from '../civicNonces';
import { devicePairingSessions } from '../devicePairingSessions';
import { deviceSessionAccounts } from '../deviceSessionAccounts';
import { deviceSessions } from '../deviceSessions';
import { domainVerifications } from '../domainVerifications';
import { identityBackups } from '../identityBackups';
import { identityBindings } from '../identityBindings';
import { PROTECTED_COLUMNS_BY_TABLE } from '../protectedColumns';
import {
  SECURITY_ACTIVITY_RETENTION_SECONDS,
  SECURITY_EVENT_SEVERITIES,
  SECURITY_EVENT_SEVERITY_MAP,
  SECURITY_EVENT_TYPES,
  securityActivities,
} from '../securityActivities';
import { sessions } from '../sessions';
import { users } from '../users';
import { webauthnChallenges } from '../webauthnChallenges';

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';
/** Postgres `check_violation`. */
const CHECK_VIOLATION = '23514';
/** Postgres `foreign_key_violation`. */
const FOREIGN_KEY_VIOLATION = '23503';

/** Every table this file covers. Used as the vacuity floor for the sweep checks. */
const CLUSTER_TABLES = [
  sessions,
  authCodes,
  authSessions,
  deviceSessions,
  deviceSessionAccounts,
  devicePairingSessions,
  webauthnChallenges,
  identityBackups,
  identityBindings,
  domainVerifications,
  civicNonces,
  securityActivities,
];

/** Tables of this batch that had a Mongo TTL index, and what it replaced. */
const EXPECTED_SWEEP_RETENTIONS: ReadonlyArray<readonly [string, number]> = [
  ['sessions', 0],
  ['webauthn_challenges', 0],
  ['domain_verifications', 0],
  ['device_pairing_sessions', 0],
  ['civic_nonces', 600],
  ['auth_sessions', 3600],
  ['auth_codes', 300],
  ['security_activities', SECURITY_ACTIVITY_RETENTION_SECONDS],
];

/**
 * The SQLSTATE a driver error carries. Drizzle wraps the driver failure, so the
 * code lives on the `cause` — walking the chain is what makes an assertion say
 * "the constraint fired" rather than "some error happened".
 */
function pgErrorCode(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const code: unknown = Reflect.get(current, 'code');
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** The message a driver error carries, for asserting WHICH constraint fired. */
function pgErrorText(error: unknown): string {
  const parts: string[] = [];
  for (let current = error; current instanceof Error; current = current.cause) {
    parts.push(current.message);
    const constraint: unknown = Reflect.get(current, 'constraint_name');
    if (typeof constraint === 'string') parts.push(constraint);
  }
  return parts.join(' | ');
}

/**
 * Await a query expecting a rejection, and return the error. Awaiting a drizzle
 * builder twice RUNS it twice, so this issues exactly one statement.
 */
async function rejection(query: Promise<unknown>): Promise<unknown> {
  try {
    await query;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the query to be rejected by a constraint, but it succeeded.');
}

/** A real `users` row — every `user_id` in this file carries a foreign key. */
async function owner(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

/**
 * A real `applications` row.
 *
 * `auth_codes.application_id`, `auth_sessions.application_id` and
 * `identity_bindings.application_id` took a fabricated string until
 * `applications` landed; each now carries the foreign key this file's own
 * deferred-FK ledger had already decided on, and that is the point of the
 * constraint. Each call mints its own owning account and application, so no
 * assertion depends on another test's rows.
 */
async function application(): Promise<string> {
  const [row] = await getDb()
    .insert(applications)
    .values({ name: `App ${randomUUID()}`, ownerAccountId: await owner() })
    .returning({ id: applications.id });
  return row.id;
}

/** A minimal valid `sessions` row for `userId`. */
async function session(userId: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const [row] = await getDb()
    .insert(sessions)
    .values({
      sessionId: `sid-${randomUUID()}`,
      userId,
      deviceId: `dev-${randomUUID()}`,
      deviceType: 'web',
      platform: 'web',
      accessToken: `at-${randomUUID()}`,
      refreshToken: `rt-${randomUUID()}`,
      expiresAt: new Date(Date.now() + 3_600_000),
      ...overrides,
    })
    .returning({ id: sessions.id });
  return row.id;
}

/** A minimal valid `auth_sessions` row — a device sign-in request. */
async function deviceSignInRequest(
  overrides: Record<string, unknown> = {}
): Promise<{ id: string }> {
  const [row] = await getDb()
    .insert(authSessions)
    .values({
      sessionToken: `st-${randomUUID()}`,
      applicationId: await application(),
      expiresAt: new Date(Date.now() + 3_600_000),
      ...overrides,
    })
    .returning({ id: authSessions.id });
  return row;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('sparse-unique becomes a plain UNIQUE on a nullable column', () => {
  it('lets many device rows carry NO secret hash at once', async () => {
    // Mongo needed `sparse: true` + `default: undefined` here because its
    // unique index collides on nulls. If that workaround had been carried over
    // as `default: ''`, this insert would fail on the second row.
    const deviceIds = [`d-${randomUUID()}`, `d-${randomUUID()}`, `d-${randomUUID()}`];
    await expect(
      getDb()
        .insert(deviceSessions)
        .values(deviceIds.map((deviceId) => ({ deviceId })))
    ).resolves.toBeDefined();

    const rows = await getDb()
      .select({ secretHash: deviceSessions.secretHash })
      .from(deviceSessions)
      .where(inArray(deviceSessions.deviceId, deviceIds));

    expect(rows).toHaveLength(3);
    // NULL, never `''` — an empty string is a VALUE and would collide for real.
    expect(rows.map((row) => row.secretHash)).toEqual([null, null, null]);
  });

  it('still refuses two devices bound to the SAME secret hash', async () => {
    const secretHash = `sha-${randomUUID()}`;
    await getDb().insert(deviceSessions).values({ deviceId: `d-${randomUUID()}`, secretHash });

    const error = await rejection(
      getDb().insert(deviceSessions).values({ deviceId: `d-${randomUUID()}`, secretHash })
    );

    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
    expect(pgErrorText(error)).toContain('device_sessions_secret_hash_key');
  });

  it('lets many authorization requests carry NO authorize code at once', async () => {
    const first = await deviceSignInRequest();
    const second = await deviceSignInRequest();

    const rows = await getDb()
      .select({ id: authSessions.id, authorizeCode: authSessions.authorizeCode })
      .from(authSessions)
      .where(sql`${authSessions.id} in (${first.id}, ${second.id})`);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.authorizeCode)).toEqual([null, null]);
  });

  it('still refuses two requests sharing an authorize code', async () => {
    const authorizeCode = `code-${randomUUID()}`;
    await deviceSignInRequest({ authorizeCode });

    const error = await rejection(deviceSignInRequest({ authorizeCode }));

    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
    expect(pgErrorText(error)).toContain('auth_sessions_authorize_code_key');
  });

  it("shows why `''` would be worse than the problem it looks like a fix for", async () => {
    // The claim the two assertions above rest on, demonstrated rather than
    // asserted: an empty string is a VALUE, so a `default: ''` port of Mongo's
    // `default: undefined` would make every secret-less device collide with
    // every other one — converting a non-problem into a live outage.
    await getDb().delete(deviceSessions).where(eq(deviceSessions.secretHash, ''));
    await getDb().insert(deviceSessions).values({ deviceId: `d-${randomUUID()}`, secretHash: '' });

    const error = await rejection(
      getDb().insert(deviceSessions).values({ deviceId: `d-${randomUUID()}`, secretHash: '' })
    );

    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
    await getDb().delete(deviceSessions).where(eq(deviceSessions.secretHash, ''));
  });

  it('never defaults either column to an empty string', async () => {
    const rows = await getDb().execute<{ table_name: string; column_name: string }>(sql`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public'
        and (table_name, column_name) in (
          ('device_sessions', 'secret_hash'), ('auth_sessions', 'authorize_code')
        )
        and column_default is not null
    `);

    expect(rows.map((row) => `${row.table_name}.${row.column_name}`)).toEqual([]);
  });
});

describe('AuthSession.oauth stays NULL rather than becoming {}', () => {
  it('leaves every oauth column NULL on a device sign-in row', async () => {
    const { id } = await deviceSignInRequest();

    const [row] = await getDb().select().from(authSessions).where(eq(authSessions.id, id));

    // The Mongoose sub-schema exists so this path stays `undefined` instead of
    // materialising an empty object that reads as truthy. Four separate NULLs
    // are the port of that, and `{}` has no representation here at all.
    expect(row.purpose).toBe('device_sign_in');
    expect(row.oauthRedirectUri).toBeNull();
    expect(row.oauthCodeChallenge).toBeNull();
    expect(row.oauthCodeChallengeMethod).toBeNull();
    expect(row.oauthScopes).toBeNull();
    expect(row.oauthSubjectAccountId).toBeNull();
  });

  it('distinguishes an absent binding from one with no scopes', async () => {
    const { id } = await deviceSignInRequest({
      purpose: 'oauth_authorization',
      oauthRedirectUri: 'https://rp.example/cb',
      oauthCodeChallenge: 'challenge',
      oauthCodeChallengeMethod: 'S256',
      oauthScopes: [],
    });

    const [row] = await getDb().select().from(authSessions).where(eq(authSessions.id, id));

    // `[]` is a VALUE ("bound, requesting nothing"); NULL is "not bound". The
    // whole point of the all-or-nothing CHECK is that these stay distinguishable.
    expect(row.oauthScopes).toEqual([]);
    expect(row.oauthRedirectUri).toBe('https://rp.example/cb');
  });

  it('refuses a HALF-written binding', async () => {
    const error = await rejection(
      deviceSignInRequest({
        purpose: 'oauth_authorization',
        oauthRedirectUri: 'https://rp.example/cb',
        oauthCodeChallenge: 'challenge',
        oauthCodeChallengeMethod: 'S256',
        // `oauthScopes` deliberately omitted — the binding is not whole.
      })
    );

    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
    expect(pgErrorText(error)).toContain('auth_sessions_oauth_binding_check');
  });

  it('refuses a binding on a device-sign-in purpose', async () => {
    const error = await rejection(
      deviceSignInRequest({
        purpose: 'device_sign_in',
        oauthRedirectUri: 'https://rp.example/cb',
        oauthCodeChallenge: 'challenge',
        oauthCodeChallengeMethod: 'S256',
        oauthScopes: ['read'],
      })
    );

    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
    expect(pgErrorText(error)).toContain('auth_sessions_oauth_purpose_check');
  });

  it('refuses an oauth purpose with NO binding — the unfinalizable row', async () => {
    const error = await rejection(deviceSignInRequest({ purpose: 'oauth_authorization' }));

    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
    expect(pgErrorText(error)).toContain('auth_sessions_oauth_purpose_check');
  });

  it('refuses a delegated subject without a binding to delegate within', async () => {
    const error = await rejection(
      deviceSignInRequest({ oauthSubjectAccountId: await owner() })
    );

    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
    expect(pgErrorText(error)).toContain('auth_sessions_oauth_subject_requires_binding_check');
  });

  it('keeps `requester_label` a label, not a fingerprint', async () => {
    // Mongoose's `maxlength: 64` is a fail-closed guard: a writer that tried to
    // persist a whole User-Agent here must fail rather than quietly widen this
    // column into a device fingerprint.
    const error = await rejection(
      deviceSignInRequest({
        requesterLabel:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      })
    );

    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
    expect(pgErrorText(error)).toContain('auth_sessions_requester_label_length_check');

    await expect(deviceSignInRequest({ requesterLabel: 'Chrome on Windows' })).resolves.toBeDefined();
  });
});

describe('device_session_accounts — the child table that keeps two user FKs real', () => {
  it('cascades an account off every device when the account is deleted', async () => {
    const accountId = await owner();
    const otherId = await owner();
    const [device] = await getDb()
      .insert(deviceSessions)
      .values({ deviceId: `d-${randomUUID()}` })
      .returning({ id: deviceSessions.id });

    await getDb().insert(deviceSessionAccounts).values([
      { deviceSessionId: device.id, accountId, sessionId: `sid-${randomUUID()}`, authuser: 0 },
      { deviceSessionId: device.id, accountId: otherId, sessionId: `sid-${randomUUID()}`, authuser: 1 },
    ]);

    await getDb().delete(users).where(eq(users.id, accountId));

    const remaining = await getDb()
      .select({ accountId: deviceSessionAccounts.accountId })
      .from(deviceSessionAccounts)
      .where(eq(deviceSessionAccounts.deviceSessionId, device.id));

    // The deleted account's entry is gone; the OTHER account's entry — and the
    // device itself — survive. A jsonb `accounts[]` could do neither.
    expect(remaining.map((row) => row.accountId)).toEqual([otherId]);
    const devices = await getDb()
      .select({ id: deviceSessions.id })
      .from(deviceSessions)
      .where(eq(deviceSessions.id, device.id));
    expect(devices).toHaveLength(1);
  });

  it('deletes a delegated entry when its OPERATOR is deleted, never orphans it', async () => {
    const operatorId = await owner();
    const managedId = await owner();
    const [device] = await getDb()
      .insert(deviceSessions)
      .values({ deviceId: `d-${randomUUID()}` })
      .returning({ id: deviceSessions.id });

    await getDb().insert(deviceSessionAccounts).values({
      deviceSessionId: device.id,
      accountId: managedId,
      sessionId: `sid-${randomUUID()}`,
      authuser: 0,
      operatedByUserId: operatorId,
    });

    await getDb().delete(users).where(eq(users.id, operatorId));

    // `SET NULL` here would leave the managed account sitting on the device as
    // an ordinary entry, mintable with no `account:act_as` re-check at all.
    const remaining = await getDb()
      .select()
      .from(deviceSessionAccounts)
      .where(eq(deviceSessionAccounts.deviceSessionId, device.id));
    expect(remaining).toEqual([]);
  });

  it('takes every entry with the device row', async () => {
    const [device] = await getDb()
      .insert(deviceSessions)
      .values({ deviceId: `d-${randomUUID()}` })
      .returning({ id: deviceSessions.id });
    await getDb().insert(deviceSessionAccounts).values({
      deviceSessionId: device.id,
      accountId: await owner(),
      sessionId: `sid-${randomUUID()}`,
      authuser: 0,
    });

    await getDb().delete(deviceSessions).where(eq(deviceSessions.id, device.id));

    const remaining = await getDb()
      .select()
      .from(deviceSessionAccounts)
      .where(eq(deviceSessionAccounts.deviceSessionId, device.id));
    expect(remaining).toEqual([]);
  });

  it('refuses an entry for a device or an account that does not exist', async () => {
    const missingDevice = await rejection(
      getDb().insert(deviceSessionAccounts).values({
        deviceSessionId: `ghost-${randomUUID()}`,
        accountId: await owner(),
        sessionId: `sid-${randomUUID()}`,
        authuser: 0,
      })
    );
    expect(pgErrorCode(missingDevice)).toBe(FOREIGN_KEY_VIOLATION);

    const [device] = await getDb()
      .insert(deviceSessions)
      .values({ deviceId: `d-${randomUUID()}` })
      .returning({ id: deviceSessions.id });
    const missingAccount = await rejection(
      getDb().insert(deviceSessionAccounts).values({
        deviceSessionId: device.id,
        accountId: `ghost-${randomUUID()}`,
        sessionId: `sid-${randomUUID()}`,
        authuser: 0,
      })
    );
    expect(pgErrorCode(missingAccount)).toBe(FOREIGN_KEY_VIOLATION);
  });

  it('refuses the same account twice on one device', async () => {
    const accountId = await owner();
    const [device] = await getDb()
      .insert(deviceSessions)
      .values({ deviceId: `d-${randomUUID()}` })
      .returning({ id: deviceSessions.id });
    await getDb().insert(deviceSessionAccounts).values({
      deviceSessionId: device.id,
      accountId,
      sessionId: `sid-${randomUUID()}`,
      authuser: 0,
    });

    const error = await rejection(
      getDb().insert(deviceSessionAccounts).values({
        deviceSessionId: device.id,
        accountId,
        sessionId: `sid-${randomUUID()}`,
        authuser: 1,
      })
    );

    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
    expect(pgErrorText(error)).toContain(
      'device_session_accounts_device_session_id_account_id_key'
    );
  });

  it('refuses a negative authuser', async () => {
    const [device] = await getDb()
      .insert(deviceSessions)
      .values({ deviceId: `d-${randomUUID()}` })
      .returning({ id: deviceSessions.id });

    const error = await rejection(
      getDb().insert(deviceSessionAccounts).values({
        deviceSessionId: device.id,
        accountId: await owner(),
        sessionId: `sid-${randomUUID()}`,
        authuser: -1,
      })
    );

    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
    expect(pgErrorText(error)).toContain('device_session_accounts_authuser_check');
  });

  it('keeps the entry when the session it names is swept away', async () => {
    // The lifecycles are independent BY DESIGN: `resolveActiveToken` must be
    // able to answer "dead session", which it cannot do if the entry vanished
    // with it — and a vanishing entry would also skip the `revision` bump every
    // real membership change makes.
    const userId = await owner();
    const sessionId = `sid-${randomUUID()}`;
    const rowId = await session(userId, { sessionId, expiresAt: new Date(Date.now() - 60_000) });
    const [device] = await getDb()
      .insert(deviceSessions)
      .values({ deviceId: `d-${randomUUID()}` })
      .returning({ id: deviceSessions.id });
    await getDb()
      .insert(deviceSessionAccounts)
      .values({ deviceSessionId: device.id, accountId: userId, sessionId, authuser: 0 });

    await getDb().delete(sessions).where(eq(sessions.id, rowId));

    const remaining = await getDb()
      .select({ sessionId: deviceSessionAccounts.sessionId })
      .from(deviceSessionAccounts)
      .where(eq(deviceSessionAccounts.deviceSessionId, device.id));
    expect(remaining.map((row) => row.sessionId)).toEqual([sessionId]);
  });
});

describe('device_sessions — the two SET NULL relations', () => {
  it('clears the active account without destroying the device', async () => {
    const accountId = await owner();
    const [device] = await getDb()
      .insert(deviceSessions)
      .values({ deviceId: `d-${randomUUID()}`, activeAccountId: accountId })
      .returning({ id: deviceSessions.id });

    await getDb().delete(users).where(eq(users.id, accountId));

    const [row] = await getDb()
      .select({ activeAccountId: deviceSessions.activeAccountId })
      .from(deviceSessions)
      .where(eq(deviceSessions.id, device.id));

    // CASCADE here would delete the whole device when ONE of several accounts
    // is deleted, taking every other account's entry with it.
    expect(row.activeAccountId).toBeNull();
  });

  it('disarms the background credential rather than widening it', async () => {
    const accountId = await owner();
    const [device] = await getDb()
      .insert(deviceSessions)
      .values({
        deviceId: `d-${randomUUID()}`,
        backgroundSecretHash: `bg-${randomUUID()}`,
        backgroundSecretAccountId: accountId,
        backgroundSecretExpiresAt: new Date(Date.now() + 3_600_000),
      })
      .returning({ id: deviceSessions.id });

    await getDb().delete(users).where(eq(users.id, accountId));

    const [row] = await getDb()
      .select({ accountId: deviceSessions.backgroundSecretAccountId })
      .from(deviceSessions)
      .where(eq(deviceSessions.id, device.id));

    // `mintFromBackgroundSecret` refuses outright when the bound account is
    // falsy, so NULL here means the credential is dead — this SET NULL fails
    // CLOSED, which is what makes it the right choice and not the
    // `push_tokens.application_id` trap.
    expect(row.accountId).toBeNull();
  });
});

describe('sessions', () => {
  it('cascades an operator delete rather than laundering a delegated session', async () => {
    const managedId = await owner();
    const operatorId = await owner();
    const rowId = await session(managedId, { operatedByUserId: operatorId });

    await getDb().delete(users).where(eq(users.id, operatorId));

    // `SET NULL` would leave a live session on the managed account with no
    // operator recorded — and the `account:act_as` re-check that bounds its
    // validity keys off this column being set.
    const remaining = await getDb().select().from(sessions).where(eq(sessions.id, rowId));
    expect(remaining).toEqual([]);
  });

  it('refuses two sessions sharing an access or refresh token', async () => {
    const userId = await owner();
    const accessToken = `at-${randomUUID()}`;
    const refreshToken = `rt-${randomUUID()}`;
    await session(userId, { accessToken, refreshToken });

    const sameAccess = await rejection(session(await owner(), { accessToken }));
    expect(pgErrorText(sameAccess)).toContain('sessions_access_token_key');

    const sameRefresh = await rejection(session(await owner(), { refreshToken }));
    expect(pgErrorText(sameRefresh)).toContain('sessions_refresh_token_key');
  });

  it('flattens deviceInfo to real columns, not jsonb', async () => {
    const rows = await getDb().execute<{ column_name: string; data_type: string }>(sql`
      select column_name, data_type from information_schema.columns
      where table_schema = 'public' and table_name = 'sessions'
    `);
    const byName = new Map(rows.map((row) => [row.column_name, row.data_type]));

    // `deviceInfo.fingerprint` carried its own Mongo index, which a jsonb blob
    // could not serve without a hand-written expression index per path.
    expect(byName.get('device_fingerprint')).toBe('text');
    expect(byName.get('last_active_at')).toBe('timestamp with time zone');
    expect(byName.get('device_type')).toBe('text');
    expect(byName.has('device_info')).toBe(false);
    expect([...byName.values()]).not.toContain('jsonb');
  });
});

describe('protected columns — the credentials this batch adds', () => {
  it('withholds every live bearer credential from the sanctioned read', async () => {
    const sessionColumns = Object.keys(publicColumns(sessions, PROTECTED_COLUMNS_BY_TABLE));
    expect(sessionColumns).not.toContain('accessToken');
    expect(sessionColumns).not.toContain('refreshToken');
    expect(sessionColumns).not.toContain('previousRefreshToken');
    // …and keeps everything a device DTO is actually built from.
    expect(sessionColumns).toContain('deviceName');
    expect(sessionColumns).toContain('lastActiveAt');

    const requestColumns = Object.keys(publicColumns(authSessions, PROTECTED_COLUMNS_BY_TABLE));
    expect(requestColumns).not.toContain('sessionToken');
    // The PUBLIC handle stays selectable — it is what travels in the QR.
    expect(requestColumns).toContain('authorizeCode');
  });

  it('registers them under the SQL table name the runtime filter looks up', () => {
    // `publicColumns` resolves the registry by `getTableName`, so a registry key
    // written in camelCase would silently withhold nothing at all.
    expect(Object.keys(PROTECTED_COLUMNS_BY_TABLE)).toEqual(
      expect.arrayContaining([getTableName(sessions), getTableName(authSessions)])
    );
  });
});

describe('expiry registry — every Mongo TTL index in this batch', () => {
  it('registers each one with the retention its TTL declared', () => {
    const registered = new Map(
      EXPIRY_SWEEP_TARGETS.map((target) => [getTableName(target.table), target.retentionSeconds])
    );

    for (const [table, retentionSeconds] of EXPECTED_SWEEP_RETENTIONS) {
      expect([table, registered.get(table)]).toEqual([table, retentionSeconds]);
    }
    // Vacuity floor: a broken lookup above would compare undefined to undefined.
    expect(EXPECTED_SWEEP_RETENTIONS).toHaveLength(8);
  });

  it('has a supporting btree index on every swept column of this batch', async () => {
    const clusterNames = new Set(CLUSTER_TABLES.map((table) => getTableName(table)));
    const unindexed: string[] = [];
    let checked = 0;

    for (const target of EXPIRY_SWEEP_TARGETS) {
      const table = getTableName(target.table);
      if (!clusterNames.has(table)) continue;
      checked += 1;
      const column = sqlColumnName(target.column);
      const rows = await getDb().execute<{ indexdef: string }>(sql`
        select indexdef from pg_indexes where schemaname = 'public' and tablename = ${table}
      `);
      const leadsWithColumn = new RegExp(`\\(${column}\\b`);
      if (!rows.some((row) => leadsWithColumn.test(row.indexdef))) {
        unindexed.push(`${table}.${column}`);
      }
    }

    expect(unindexed).toEqual([]);
    expect(checked).toBe(EXPECTED_SWEEP_RETENTIONS.length);
  });

  it('keeps a just-expired authorization code so a replay is still detectable', async () => {
    // The 5-minute pad is the point: without it a replay of a recently-expired
    // code answers "no such code" instead of "already used".
    const target = EXPIRY_SWEEP_TARGETS.find(
      (candidate) => getTableName(candidate.table) === 'auth_codes'
    );
    if (!target) throw new Error('auth_codes is not registered for sweeping');

    const userId = await owner();
    const justExpired = `hash-${randomUUID()}`;
    const longExpired = `hash-${randomUUID()}`;
    await getDb().insert(authCodes).values([
      {
        codeHash: justExpired,
        userId,
        applicationId: await application(),
        redirectUri: 'https://rp.example/cb',
        usedAt: new Date(),
        expiresAt: new Date(Date.now() - 60_000),
      },
      {
        codeHash: longExpired,
        userId,
        applicationId: await application(),
        redirectUri: 'https://rp.example/cb',
        usedAt: new Date(),
        expiresAt: new Date(Date.now() - 600_000),
      },
    ]);

    await sweepExpiredRows(getDb(), target);

    const remaining = await getDb()
      .select({ codeHash: authCodes.codeHash })
      .from(authCodes)
      .where(eq(authCodes.userId, userId));

    expect(remaining.map((row) => row.codeHash)).toEqual([justExpired]);
  });

  it('sweeps a session strictly past its own deadline', async () => {
    const target = EXPIRY_SWEEP_TARGETS.find(
      (candidate) => getTableName(candidate.table) === 'sessions'
    );
    if (!target) throw new Error('sessions is not registered for sweeping');

    const userId = await owner();
    await session(userId, { expiresAt: new Date(Date.now() - 60_000) });
    const live = await session(userId, { expiresAt: new Date(Date.now() + 600_000) });

    await sweepExpiredRows(getDb(), target);

    const remaining = await getDb()
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, userId));
    expect(remaining.map((row) => row.id)).toEqual([live]);
  });

  it('measures the security-activity retention from the EVENT, not the row write', async () => {
    const target = EXPIRY_SWEEP_TARGETS.find(
      (candidate) => getTableName(candidate.table) === 'security_activities'
    );
    if (!target) throw new Error('security_activities is not registered for sweeping');
    // The registry must point at `occurred_at`; pointing it at `created_at`
    // would delete a backfilled two-year-old event on the day it was inserted.
    expect(sqlColumnName(target.column)).toBe('occurred_at');

    const userId = await owner();
    const second = 1_000;
    await getDb().insert(securityActivities).values([
      {
        userId,
        eventType: 'sign_in',
        eventDescription: 'stale',
        occurredAt: new Date(Date.now() - (SECURITY_ACTIVITY_RETENTION_SECONDS + 86_400) * second),
      },
      {
        userId,
        eventType: 'sign_in',
        eventDescription: 'fresh',
        occurredAt: new Date(Date.now() - (SECURITY_ACTIVITY_RETENTION_SECONDS - 86_400) * second),
      },
    ]);

    await sweepExpiredRows(getDb(), target);

    const remaining = await getDb()
      .select({ description: securityActivities.eventDescription })
      .from(securityActivities)
      .where(eq(securityActivities.userId, userId));
    expect(remaining.map((row) => row.description)).toEqual(['fresh']);
  });
});

describe('security_activities', () => {
  it('carries no IP column, in any form, on any table of this batch', async () => {
    // Platform-wide no-user-IPs-at-rest invariant. `SecurityActivity.ipAddress`
    // was REMOVED, as were `Session.deviceInfo.{ipAddress,location}`; raw,
    // hashed and geo-derived (country included) forms are all forbidden.
    const tables = CLUSTER_TABLES.map((table) => getTableName(table));
    const rows = await getDb().execute<{ table_name: string; column_name: string }>(sql`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public' and table_name in ${sql`(${sql.join(
        tables.map((name) => sql`${name}`),
        sql`, `
      )})`}
    `);

    // Whole-token matching, not substring: `/ip/` alone flags
    // `event_descr(ip)tion`, and a check that cries wolf is one someone deletes.
    const forbidden =
      /(^|_)(ip|ips|ipaddr|ipaddress|geo|geoip|country|city|region|latitude|longitude|remote|addr)(_|$)/;

    expect(rows.length).toBeGreaterThanOrEqual(120);
    expect(
      rows
        .filter((row) => forbidden.test(row.column_name))
        .map((row) => `${row.table_name}.${row.column_name}`)
    ).toEqual([]);
  });

  it('rejects an unrecognised event type from a raw write', async () => {
    const error = await rejection(
      getDb().execute(sql`
        insert into security_activities (id, user_id, event_type, event_description)
        values (${randomUUID()}, ${await owner()}, 'password_bruteforced', 'x')
      `)
    );

    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
    expect(pgErrorText(error)).toContain('security_activities_event_type_check');
  });

  it('keeps metadata as queryable jsonb defaulting to {}', async () => {
    const userId = await owner();
    await getDb().insert(securityActivities).values([
      { userId, eventType: 'backup_created', eventDescription: 'plain' },
      {
        userId,
        eventType: 'device_added',
        eventDescription: 'detailed',
        metadata: { deviceName: 'Pixel', nested: { count: 2 } },
      },
    ]);

    const rows = await getDb()
      .select({ description: securityActivities.eventDescription, metadata: securityActivities.metadata })
      .from(securityActivities)
      .where(eq(securityActivities.userId, userId));
    const plain = rows.find((row) => row.description === 'plain');
    const detailed = rows.find((row) => row.description === 'detailed');

    expect(plain?.metadata).toEqual({});
    expect(detailed?.metadata).toEqual({ deviceName: 'Pixel', nested: { count: 2 } });
  });
});

describe('identity_backups — two timestamps that are not the same thing', () => {
  it('returns the client snapshot string byte for byte', async () => {
    // Stored as `text` on purpose: the public restore endpoint hands back the
    // exact envelope that was uploaded, and a `timestamptz` would re-render it.
    const clientCreatedAt = '2026-03-04T05:06:07.008Z';
    const userId = await owner();
    await getDb().insert(identityBackups).values({
      userId,
      lookupIdHash: `lookup-${randomUUID()}`,
      publicKeyHint: '02ab',
      ciphertext: 'deadbeef',
      nonce: 'cafe',
      algorithm: 'xchacha20poly1305',
      kdfInfo: 'oxy-identity-backup-v1',
      version: 1,
      clientCreatedAt,
    });

    const [row] = await getDb()
      .select()
      .from(identityBackups)
      .where(eq(identityBackups.userId, userId));

    expect(row.clientCreatedAt).toBe(clientCreatedAt);
    expect(typeof row.clientCreatedAt).toBe('string');
    expect(row.updatedAt).toBeInstanceOf(Date);
  });

  it('has no created_at — the absence is deliberate, not an omission', async () => {
    // Mongoose declared `createdAt: false` because the client's value held the
    // name. A `DEFAULT now()` column would stamp every backfilled row with the
    // migration date, asserting a falsehood about every backup that exists.
    const rows = await getDb().execute<{ column_name: string }>(sql`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'identity_backups'
    `);
    const names = rows.map((row) => row.column_name);

    expect(names).toContain('client_created_at');
    expect(names).toContain('updated_at');
    expect(names).not.toContain('created_at');
  });

  it('allows only one backup per account', async () => {
    const userId = await owner();
    const values = {
      userId,
      publicKeyHint: '02ab',
      ciphertext: 'deadbeef',
      nonce: 'cafe',
      algorithm: 'xchacha20poly1305',
      kdfInfo: 'oxy-identity-backup-v1',
      version: 1,
      clientCreatedAt: new Date().toISOString(),
    };
    await getDb().insert(identityBackups).values({ ...values, lookupIdHash: `l-${randomUUID()}` });

    const error = await rejection(
      getDb().insert(identityBackups).values({ ...values, lookupIdHash: `l-${randomUUID()}` })
    );

    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
    expect(pgErrorText(error)).toContain('identity_backups_user_id_key');
  });
});

describe('identity_bindings — history survives a rebind', () => {
  it('permits many REVOKED rows for one local principal but only one active', async () => {
    const applicationId = await application();
    const localPrincipalId = `principal-${randomUUID()}`;
    const base = { applicationId, localPrincipalId, bindingType: 'session_proof' as const };

    await getDb().insert(identityBindings).values([
      { ...base, userId: await owner(), status: 'revoked', revokedAt: new Date() },
      { ...base, userId: await owner(), status: 'revoked', revokedAt: new Date() },
      { ...base, userId: await owner() },
    ]);

    const error = await rejection(
      getDb().insert(identityBindings).values({ ...base, userId: await owner() })
    );

    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
    expect(pgErrorText(error)).toContain(
      'identity_bindings_application_id_local_principal_id_active_key'
    );
  });

  it('refuses a row whose status and revoked_at disagree', async () => {
    const base = {
      applicationId: await application(),
      localPrincipalId: `principal-${randomUUID()}`,
      bindingType: 'oauth_grant' as const,
      userId: await owner(),
    };

    // Revoked with no timestamp: the engine's "is not revoked" check reads
    // `status`, so the reverse shape below would keep producing effects.
    const noTimestamp = await rejection(
      getDb().insert(identityBindings).values({ ...base, status: 'revoked' })
    );
    expect(pgErrorText(noTimestamp)).toContain('identity_bindings_revoked_at_check');

    const activeButRevoked = await rejection(
      getDb().insert(identityBindings).values({ ...base, revokedAt: new Date() })
    );
    expect(pgErrorText(activeButRevoked)).toContain('identity_bindings_revoked_at_check');
  });
});

describe('domain_verifications — one live challenge per (user, domain)', () => {
  it('compares the domain case-insensitively, as the lowercase setter did', async () => {
    const userId = await owner();
    const domain = `Example-${randomUUID()}.test`;
    await getDb()
      .insert(domainVerifications)
      .values({ userId, domain, token: 'a', expiresAt: new Date(Date.now() + 86_400_000) });

    const error = await rejection(
      getDb().insert(domainVerifications).values({
        userId,
        domain: domain.toUpperCase(),
        token: 'b',
        expiresAt: new Date(Date.now() + 86_400_000),
      })
    );

    // Two live tokens for one domain is exactly what the model promises cannot
    // happen, and Mongoose's `lowercase: true` setter has no Postgres analogue.
    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
    expect(pgErrorText(error)).toContain('domain_verifications_user_id_lower_domain_key');
  });

  it('drops the two fields no call site reads', async () => {
    const rows = await getDb().execute<{ column_name: string }>(sql`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'domain_verifications'
    `);
    const names = rows.map((row) => row.column_name);

    expect(names.length).toBeGreaterThan(3);
    // `status` was a one-value enum nobody read; `method` was documented as
    // "set at verify time" but the verify path deletes the row instead.
    expect(names).not.toContain('status');
    expect(names).not.toContain('method');
  });
});

describe('civic_nonces and webauthn_challenges — single-use, unforgeably', () => {
  it('refuses a replayed civic nonce', async () => {
    const nonceHash = `nonce-${randomUUID()}`;
    await getDb().insert(civicNonces).values({
      nonceHash,
      purpose: 'real_life_attestation',
      subjectUserId: await owner(),
      expiresAt: new Date(Date.now() + 600_000),
    });

    const error = await rejection(
      getDb().insert(civicNonces).values({
        nonceHash,
        purpose: 'real_life_attestation',
        expiresAt: new Date(Date.now() + 600_000),
      })
    );

    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
    expect(pgErrorText(error)).toContain('civic_nonces_nonce_hash_key');
  });

  it('binds a WebAuthn ceremony to an account only when there is one', async () => {
    const userId = await owner();
    await getDb().insert(webauthnChallenges).values([
      {
        challenge: `c-${randomUUID()}`,
        type: 'authentication',
        expiresAt: new Date(Date.now() + 300_000),
      },
      {
        challenge: `c-${randomUUID()}`,
        type: 'registration',
        userId,
        expiresAt: new Date(Date.now() + 300_000),
      },
    ]);

    const bound = await getDb()
      .select({ used: webauthnChallenges.used })
      .from(webauthnChallenges)
      .where(eq(webauthnChallenges.userId, userId));

    // NULL `user_id` is the discoverable-login case, not a missing value.
    expect(bound).toEqual([{ used: false }]);
  });
});

describe('device_pairing_sessions', () => {
  it('refuses a half-sealed approval', async () => {
    const error = await rejection(
      getDb().insert(devicePairingSessions).values({
        pairingId: `p-${randomUUID()}`,
        newDeviceEphemeralPublicKey: '02aa',
        status: 'approved',
        ciphertext: 'deadbeef',
        expiresAt: new Date(Date.now() + 180_000),
      })
    );

    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
    expect(pgErrorText(error)).toContain('device_pairing_sessions_sealed_payload_check');
  });

  it('lets the lazy read path mark a past-deadline pairing expired before the sweep', async () => {
    // The verdict a user sees comes from this write, not from the sweep. Port
    // it verbatim: without it every expired transfer becomes an unknown one.
    const pairingId = `p-${randomUUID()}`;
    await getDb().insert(devicePairingSessions).values({
      pairingId,
      newDeviceEphemeralPublicKey: '02aa',
      expiresAt: new Date(Date.now() - 1_000),
    });

    await getDb()
      .update(devicePairingSessions)
      .set({ status: 'expired' })
      .where(
        sql`${devicePairingSessions.pairingId} = ${pairingId} and ${devicePairingSessions.status} = 'pending' and ${devicePairingSessions.expiresAt} < now()`
      );

    const [row] = await getDb()
      .select({ status: devicePairingSessions.status })
      .from(devicePairingSessions)
      .where(eq(devicePairingSessions.pairingId, pairingId));
    expect(row.status).toBe('expired');
  });
});

describe('auth_codes', () => {
  it('refuses a PKCE challenge with no method, and a method with no challenge', async () => {
    const base = {
      userId: await owner(),
      applicationId: await application(),
      redirectUri: 'https://rp.example/cb',
      expiresAt: new Date(Date.now() + 60_000),
    };

    const challengeOnly = await rejection(
      getDb().insert(authCodes).values({
        ...base,
        codeHash: `h-${randomUUID()}`,
        codeChallenge: 'abc',
      })
    );
    expect(pgErrorText(challengeOnly)).toContain('auth_codes_pkce_pair_check');

    const methodOnly = await rejection(
      getDb().insert(authCodes).values({
        ...base,
        codeHash: `h-${randomUUID()}`,
        codeChallengeMethod: 'S256',
      })
    );
    expect(pgErrorText(methodOnly)).toContain('auth_codes_pkce_pair_check');
  });

  it('defaults scopes to an empty array, which is a value and not an absence', async () => {
    const userId = await owner();
    const codeHash = `h-${randomUUID()}`;
    await getDb().insert(authCodes).values({
      codeHash,
      userId,
      applicationId: await application(),
      redirectUri: 'https://rp.example/cb',
      expiresAt: new Date(Date.now() + 60_000),
    });

    const [row] = await getDb().select().from(authCodes).where(eq(authCodes.codeHash, codeHash));
    expect(row.scopes).toEqual([]);
    expect(row.usedAt).toBeNull();
  });
});
