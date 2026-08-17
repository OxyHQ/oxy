/**
 * The `applications` cluster, against a REAL Postgres.
 *
 * One `describe` per decision in the schema files that a comment alone would not
 * keep true — the array CHECKs, the two self-referencing rotation chains, the
 * `NULLS NOT DISTINCT` idempotency key, the two columns deliberately DROPPED,
 * and what each `ON DELETE` actually does. Everything runs through the
 * application's own pool against the throwaway database `jest.globalSetup.ts`
 * migrated, so what passes is what the shipped DDL does.
 *
 * Every row carries a per-test random identifier, so no assertion depends on a
 * table being empty.
 */

import { randomUUID } from 'node:crypto';
import { eq, getTableColumns, getTableName, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../../config/postgres';
import { sqlColumnName } from '@oxyhq/db';
import { sweepExpiredRows } from '@oxyhq/db/expiry';
import { EXPIRY_SWEEP_TARGETS } from '../../expiry';
import { IDENTITY_APPROVAL_CAPABILITY } from '../../../utils/applicationCapabilities';
import {
  ACCOUNT_CREDENTIAL_ENVIRONMENTS,
  ACCOUNT_CREDENTIAL_STATUSES,
  ACCOUNT_CREDENTIAL_TYPES,
  accountCredentials,
} from '../accountCredentials';
import { ACCOUNT_MEMBER_STATUSES, accountMembers } from '../accountMembers';
import { apiKeyUsageEvents } from '../apiKeyUsageEvents';
import { appAffinityEdges } from '../appAffinityEdges';
import { appEndorsementEdges } from '../appEndorsementEdges';
import { appGrants } from '../appGrants';
import {
  APPLICATION_CREDENTIAL_ENVIRONMENTS,
  APPLICATION_CREDENTIAL_STATUSES,
  APPLICATION_CREDENTIAL_TYPES,
  applicationCredentials,
} from '../applicationCredentials';
import { applicationModerationTrust } from '../applicationModerationTrust';
import { APPLICATION_STATUSES, APPLICATION_TYPES, applications } from '../applications';
import { appUserSignals } from '../appUserSignals';
import { users } from '../users';

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';
/** Postgres `check_violation`. */
const CHECK_VIOLATION = '23514';
/** Postgres `foreign_key_violation`. */
const FOREIGN_KEY_VIOLATION = '23503';

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

/**
 * The SQLSTATE a driver error carries. Drizzle wraps a driver failure in its own
 * `DrizzleQueryError`, so the code lives on the `cause` — walking the chain is
 * what stops every assertion below from degrading into "some error happened".
 */
function pgErrorCode(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const code: unknown = Reflect.get(current, 'code');
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/**
 * Await a query, expecting it to reject, and return the error. Awaiting a
 * drizzle query builder twice RUNS it twice, so this issues exactly one
 * statement.
 */
async function rejection(query: Promise<unknown>): Promise<unknown> {
  try {
    await query;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the query to be rejected by a constraint, but it succeeded.');
}

/** A real `users` row — every account/user column here carries a foreign key. */
async function account(): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ color: 'teal' })
    .returning({ id: users.id });
  return row.id;
}

/** A real `applications` row owned by a freshly-minted account. */
async function application(
  overrides: Partial<typeof applications.$inferInsert> = {}
): Promise<string> {
  const [row] = await getDb()
    .insert(applications)
    .values({
      name: `App ${randomUUID()}`,
      ownerAccountId: overrides.ownerAccountId ?? (await account()),
      ...overrides,
    })
    .returning({ id: applications.id });
  return row.id;
}

describe('applications — closed value sets and the three arrays', () => {
  it('defaults an application to an active third-party app with empty arrays', async () => {
    const id = await application();
    const [row] = await getDb().select().from(applications).where(eq(applications.id, id));

    expect(row.type).toBe('third_party');
    expect(row.status).toBe('active');
    expect(row.isOfficial).toBe(false);
    expect(row.isInternal).toBe(false);
    // Empty, not null: Mongoose defaulted all three to `[]`.
    expect(row.capabilities).toEqual([]);
    expect(row.redirectUris).toEqual([]);
    expect(row.scopes).toEqual([]);
  });

  it('rejects an undeclared type or status from a raw write', async () => {
    // Raw SQL on purpose: the typed column already refuses this at compile time,
    // so only a hand-written statement (backfill, psql) can reach the CHECK.
    const ownerAccountId = await account();
    const badType = await rejection(
      getDb().execute(sql`
        insert into applications (id, name, owner_account_id, type)
        values (${randomUUID()}, 'Bad type', ${ownerAccountId}, 'partner')
      `)
    );
    expect(pgErrorCode(badType)).toBe(CHECK_VIOLATION);

    const badStatus = await rejection(
      getDb().execute(sql`
        insert into applications (id, name, owner_account_id, status)
        values (${randomUUID()}, 'Bad status', ${ownerAccountId}, 'archived')
      `)
    );
    expect(pgErrorCode(badStatus)).toBe(CHECK_VIOLATION);
  });

  it('constrains every element of `scopes`, and only of `scopes`', async () => {
    const ownerAccountId = await account();

    // A real scope is accepted…
    await expect(
      getDb()
        .insert(applications)
        .values({ name: 'Scoped', ownerAccountId, scopes: ['files:read', 'user:read'] })
    ).resolves.toBeDefined();

    // …one element that is not, is not. The array CHECK is `<@`, so a SINGLE
    // bad element in an otherwise valid list must fail — a per-element test,
    // not a whole-array one.
    const error = await rejection(
      getDb()
        .insert(applications)
        .values({
          name: 'Bad scope',
          ownerAccountId,
          scopes: ['files:read', 'admin:everything'],
        })
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);

    // `capabilities` is deliberately UNconstrained — a staff-controlled
    // vocabulary meant to grow without a migration.
    await expect(
      getDb()
        .insert(applications)
        .values({ name: 'Future capability', ownerAccountId, capabilities: ['not:yet:declared'] })
    ).resolves.toBeDefined();
  });

  /**
   * The retirement of `chat:completions` / `models:read` (#972 workstream 3) is
   * only a clean cut if the DATABASE refuses them, not merely the Zod enum: a
   * backfill, a psql session or a stale image writes past the enum and lands on
   * the CHECK. `0031_inference_scope_family` rewrote every stored occurrence and
   * rebuilt the three application-scope CHECKs around the new vocabulary, so
   * after it no row can hold a retired name at all.
   *
   * Each rejection is paired with the SUCCESSOR name being accepted through the
   * identical statement. Without that control a constraint that had broken into
   * rejecting everything — or a column renamed out from under the test — would
   * read exactly like a successful retirement.
   */
  it('refuses a retired inference scope name and accepts its successor', async () => {
    const ownerAccountId = await account();

    for (const [retired, successor] of [
      ['chat:completions', 'inference:invoke'],
      ['models:read', 'inference:models:read'],
    ] as const) {
      // Raw SQL: the typed column no longer admits the retired string at all,
      // so only a hand-written statement can reach the CHECK.
      const error = await rejection(
        getDb().execute(sql`
          insert into applications (id, name, owner_account_id, scopes)
          values (${randomUUID()}, 'Retired scope', ${ownerAccountId},
                  array[${retired}]::text[])
        `)
      );
      expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);

      await expect(
        getDb()
          .insert(applications)
          .values({ name: 'Successor scope', ownerAccountId, scopes: [successor] })
      ).resolves.toBeDefined();
    }
  });

  it('accepts every scope of the inference family, staff-gated ones included', async () => {
    // The CHECK is a vocabulary, not an authorization: staff-gating
    // `inference:routing:write` / `inference:providers:write` is decided in
    // `applicationScopes.ts` and enforced on the write PATH, so the constraint
    // must still admit them once staff has granted one.
    await expect(
      getDb()
        .insert(applications)
        .values({
          name: 'Inference app',
          ownerAccountId: await account(),
          scopes: [
            'inference:invoke',
            'inference:models:read',
            'inference:usage:read',
            'inference:routing:read',
            'inference:routing:write',
            'inference:providers:read',
            'inference:providers:write',
          ],
        })
    ).resolves.toBeDefined();
  });

  it('answers the push-delivery query by array containment', async () => {
    const ownerAccountId = await account();
    const marker = `cap-${randomUUID()}`;
    await getDb().insert(applications).values([
      {
        name: 'Vault',
        ownerAccountId,
        capabilities: [IDENTITY_APPROVAL_CAPABILITY, marker],
      },
      { name: 'Ordinary', ownerAccountId, capabilities: [marker] },
    ]);

    // The Postgres form of `find({status:'active', capabilities: 'identity:approval'})`.
    const found = await getDb()
      .select({ name: applications.name })
      .from(applications)
      .where(
        sql`${applications.status} = 'active'
          and ${applications.capabilities} @> array[${IDENTITY_APPROVAL_CAPABILITY}]::text[]
          and ${applications.capabilities} @> array[${marker}]::text[]`
      );

    expect(found.map((row) => row.name)).toEqual(['Vault']);
  });

  it('preserves the author-supplied order of `redirect_uris`', async () => {
    const ownerAccountId = await account();
    const uris = ['https://b.example/cb', 'https://a.example/cb', 'https://c.example/cb'];
    const [row] = await getDb()
      .insert(applications)
      .values({ name: 'Ordered', ownerAccountId, redirectUris: uris })
      .returning({ redirectUris: applications.redirectUris });

    // Order is data here: `resolveRedirectUris` de-duplicates while preserving
    // the author's order, which is the reason this is an array and not a set.
    expect(row.redirectUris).toEqual(uris);
  });
});

describe('applications — what each ON DELETE means', () => {
  it('deletes the application when its OWNER ACCOUNT is erased', async () => {
    const ownerAccountId = await account();
    const applicationId = await application({ ownerAccountId });

    await getDb().delete(users).where(eq(users.id, ownerAccountId));

    const remaining = await getDb()
      .select({ id: applications.id })
      .from(applications)
      .where(eq(applications.id, applicationId));

    // Under Mongo the row survived with a dangling owner, so its OAuth client
    // and every service credential under it kept working with nobody able to
    // administer or revoke them.
    expect(remaining).toEqual([]);
  });

  it('keeps the application when its CREATOR is erased, and forgets the creator', async () => {
    const creator = await account();
    const applicationId = await application({ createdByUserId: creator });

    await getDb().delete(users).where(eq(users.id, creator));

    const rows = await getDb()
      .select({ id: applications.id, createdByUserId: applications.createdByUserId })
      .from(applications)
      .where(eq(applications.id, applicationId));

    // Attribution, not ownership: a departing member's erasure must not delete
    // an application their ORGANIZATION owns. Asserted as a row COUNT before any
    // field is read — under a CASCADE the select comes back empty, and a
    // `rows[0].id` would fail with a bare TypeError naming neither the column
    // nor the guarantee.
    expect(rows.map((row) => row.id)).toEqual([applicationId]);
    expect(rows[0].createdByUserId).toBeNull();
  });

  it('cascades an application delete through everything scoped to it', async () => {
    const applicationId = await application();
    const userId = await account();

    await getDb().insert(applicationCredentials).values({
      applicationId,
      name: 'Client',
      publicKey: `oxy_dk_${randomUUID()}`,
      type: 'public',
      environment: 'production',
    });
    await getDb().insert(appGrants).values({ userId, applicationId });
    await getDb().insert(appUserSignals).values({ applicationId, userId });
    await getDb().insert(applicationModerationTrust).values({ applicationId });

    await getDb().delete(applications).where(eq(applications.id, applicationId));

    const counts = await Promise.all([
      getDb()
        .select({ id: applicationCredentials.id })
        .from(applicationCredentials)
        .where(eq(applicationCredentials.applicationId, applicationId)),
      getDb()
        .select({ id: appGrants.id })
        .from(appGrants)
        .where(eq(appGrants.applicationId, applicationId)),
      getDb()
        .select({ id: appUserSignals.id })
        .from(appUserSignals)
        .where(eq(appUserSignals.applicationId, applicationId)),
      getDb()
        .select({ id: applicationModerationTrust.id })
        .from(applicationModerationTrust)
        .where(eq(applicationModerationTrust.applicationId, applicationId)),
    ]);

    expect(counts.map((rows) => rows.length)).toEqual([0, 0, 0, 0]);
  });

  it('refuses an application whose owner account does not exist', async () => {
    const error = await rejection(
      getDb()
        .insert(applications)
        .values({ name: 'Orphan', ownerAccountId: `missing-${randomUUID()}` })
    );
    expect(pgErrorCode(error)).toBe(FOREIGN_KEY_VIOLATION);
  });
});

describe('credentials — the application-scope vocabulary', () => {
  /**
   * Both credential tables carry the SAME `<@ APPLICATION_SCOPES` CHECK as
   * `applications`, and `0031_inference_scope_family` rebuilt all three
   * together. A test on `applications` alone would leave either credential
   * table free to hold a retired name, which is the row that actually reaches a
   * service-token mint.
   */
  it('refuses a retired scope on an application credential, and accepts its successor', async () => {
    const applicationId = await application();

    const error = await rejection(
      getDb().execute(sql`
        insert into application_credentials
          (id, application_id, name, public_key, type, environment, scopes)
        values (${randomUUID()}, ${applicationId}, 'Retired', ${`oxy_dk_${randomUUID()}`},
                'confidential', 'production', array['chat:completions']::text[])
      `)
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);

    await expect(
      getDb()
        .insert(applicationCredentials)
        .values({
          applicationId,
          name: 'Successor',
          publicKey: `oxy_dk_${randomUUID()}`,
          type: 'confidential',
          environment: 'production',
          scopes: ['inference:invoke', 'inference:providers:write'],
        })
    ).resolves.toBeDefined();
  });

  it('refuses a retired scope on an account credential, and accepts its successor', async () => {
    const accountId = await account();

    const error = await rejection(
      getDb().execute(sql`
        insert into account_credentials
          (id, account_id, name, public_key, environment, scopes)
        values (${randomUUID()}, ${accountId}, 'Retired', ${`oxy_dk_${randomUUID()}`},
                'production', array['models:read']::text[])
      `)
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);

    await expect(
      getDb()
        .insert(accountCredentials)
        .values({
          accountId,
          name: 'Successor',
          publicKey: `oxy_dk_${randomUUID()}`,
          environment: 'production',
          scopes: ['inference:models:read'],
        })
    ).resolves.toBeDefined();
  });
});

describe('credentials — the self-referencing rotation chain', () => {
  it('links a rotated credential back to the one it superseded', async () => {
    const applicationId = await application();
    const [previous] = await getDb()
      .insert(applicationCredentials)
      .values({
        applicationId,
        name: 'Old',
        publicKey: `oxy_dk_${randomUUID()}`,
        type: 'confidential',
        environment: 'production',
        status: 'deprecated',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      })
      .returning({ id: applicationCredentials.id });

    const [current] = await getDb()
      .insert(applicationCredentials)
      .values({
        applicationId,
        name: 'New',
        publicKey: `oxy_dk_${randomUUID()}`,
        type: 'confidential',
        environment: 'production',
        rotatedFromCredentialId: previous.id,
      })
      .returning({ id: applicationCredentials.id });

    // Deleting the predecessor must not take the LIVE credential with it.
    await getDb()
      .delete(applicationCredentials)
      .where(eq(applicationCredentials.id, previous.id));

    const rows = await getDb()
      .select({
        id: applicationCredentials.id,
        rotatedFromCredentialId: applicationCredentials.rotatedFromCredentialId,
      })
      .from(applicationCredentials)
      .where(eq(applicationCredentials.id, current.id));

    // Asserted as a ROW COUNT before any field is read: if
    // `application_credentials_rotated_from_fk` were CASCADE, this select would
    // come back empty and a `rows[0].id` would fail with a bare TypeError that
    // names neither the constraint nor what it protects.
    expect(rows.map((row) => row.id)).toEqual([current.id]);
    expect(rows[0].rotatedFromCredentialId).toBeNull();
  });

  it('refuses a credential that claims to supersede itself', async () => {
    const applicationId = await application();
    const id = randomUUID();
    const error = await rejection(
      getDb().execute(sql`
        insert into application_credentials
          (id, application_id, name, public_key, type, environment, rotated_from_credential_id)
        values (${id}, ${applicationId}, 'Self', ${randomUUID()}, 'service', 'production', ${id})
      `)
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('runs the same chain on account credentials', async () => {
    const accountId = await account();
    const [previous] = await getDb()
      .insert(accountCredentials)
      .values({
        accountId,
        name: 'Old bot key',
        publicKey: `oxy_dk_${randomUUID()}`,
        environment: 'production',
        status: 'deprecated',
      })
      .returning({ id: accountCredentials.id });

    const [current] = await getDb()
      .insert(accountCredentials)
      .values({
        accountId,
        name: 'New bot key',
        publicKey: `oxy_dk_${randomUUID()}`,
        environment: 'production',
        rotatedFromCredentialId: previous.id,
      })
      .returning({ id: accountCredentials.id, type: accountCredentials.type });

    // `type` defaults to the only value an account credential may hold.
    expect(current.type).toBe('service');

    await getDb().delete(accountCredentials).where(eq(accountCredentials.id, previous.id));

    const rows = await getDb()
      .select({
        id: accountCredentials.id,
        rotatedFromCredentialId: accountCredentials.rotatedFromCredentialId,
      })
      .from(accountCredentials)
      .where(eq(accountCredentials.id, current.id));

    // Row count first, for the same reason as the sibling table above.
    expect(rows.map((row) => row.id)).toEqual([current.id]);
    expect(rows[0].rotatedFromCredentialId).toBeNull();
  });

  it('rejects an application credential type on an ACCOUNT credential', async () => {
    // A one-value CHECK earns its keep here: `confidential` is meaningful on the
    // sibling table, so this is the mistake a backfill actually makes.
    const error = await rejection(
      getDb().execute(sql`
        insert into account_credentials (id, account_id, name, public_key, type, environment)
        values (${randomUUID()}, ${await account()}, 'Bad', ${randomUUID()}, 'confidential', 'production')
      `)
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('keeps `public_key` unique CASE-SENSITIVELY — it is base64url', async () => {
    const applicationId = await application();
    const publicKey = `oxy_dk_${randomUUID()}A`;

    await getDb().insert(applicationCredentials).values({
      applicationId,
      name: 'First',
      publicKey,
      type: 'public',
      environment: 'production',
    });

    // Same bytes: rejected.
    const duplicate = await rejection(
      getDb().insert(applicationCredentials).values({
        applicationId,
        name: 'Duplicate',
        publicKey,
        type: 'public',
        environment: 'production',
      })
    );
    expect(pgErrorCode(duplicate)).toBe(UNIQUE_VIOLATION);

    // Different case: a DIFFERENT client id, and it must be insertable — the
    // `lower()` treatment `users` gives its identifiers would wrongly collide
    // two legitimately distinct base64url keys.
    await expect(
      getDb().insert(applicationCredentials).values({
        applicationId,
        name: 'Recased',
        publicKey: `${publicKey.slice(0, -1)}a`,
        type: 'public',
        environment: 'production',
      })
    ).resolves.toBeDefined();
  });
});

describe('app_endorsement_edges — NULLS NOT DISTINCT idempotency', () => {
  it('collides two edges that both leave `source_id` unset', async () => {
    const applicationId = await application();
    const ownerId = await account();
    const memberId = await account();

    await getDb().insert(appEndorsementEdges).values({ applicationId, ownerId, memberId, weight: 1 });

    // Postgres treats NULLs in a unique constraint as distinct BY DEFAULT, so
    // without `NULLS NOT DISTINCT` this second insert succeeds and the
    // endorsement is counted twice.
    const error = await rejection(
      getDb().insert(appEndorsementEdges).values({ applicationId, ownerId, memberId, weight: 1 })
    );
    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
  });

  it('still allows two edges from different sources', async () => {
    const applicationId = await application();
    const ownerId = await account();
    const memberId = await account();

    await getDb()
      .insert(appEndorsementEdges)
      .values({ applicationId, ownerId, memberId, sourceId: 'list-1', weight: 1 });

    await expect(
      getDb()
        .insert(appEndorsementEdges)
        .values({ applicationId, ownerId, memberId, sourceId: 'list-2', weight: 1 })
    ).resolves.toBeDefined();
  });

  it('refuses the empty-string sentinel this port exists to remove', async () => {
    const error = await rejection(
      getDb().insert(appEndorsementEdges).values({
        applicationId: await application(),
        ownerId: await account(),
        memberId: await account(),
        sourceId: '',
        weight: 1,
      })
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('refuses a self-endorsement', async () => {
    const userId = await account();
    const error = await rejection(
      getDb()
        .insert(appEndorsementEdges)
        .values({ applicationId: await application(), ownerId: userId, memberId: userId, weight: 1 })
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });
});

describe('app_affinity_edges', () => {
  it('refuses a self-edge', async () => {
    const userId = await account();
    const error = await rejection(
      getDb()
        .insert(appAffinityEdges)
        .values({ applicationId: await application(), fromUserId: userId, toUserId: userId })
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('holds one edge per (application, from, to) but allows the reverse', async () => {
    const applicationId = await application();
    const a = await account();
    const b = await account();

    await getDb().insert(appAffinityEdges).values({ applicationId, fromUserId: a, toUserId: b });

    const error = await rejection(
      getDb().insert(appAffinityEdges).values({ applicationId, fromUserId: a, toUserId: b })
    );
    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);

    await expect(
      getDb().insert(appAffinityEdges).values({ applicationId, fromUserId: b, toUserId: a })
    ).resolves.toBeDefined();
  });

  it('leaves `last_event_at` NULL until the first fold', async () => {
    const [row] = await getDb()
      .insert(appAffinityEdges)
      .values({
        applicationId: await application(),
        fromUserId: await account(),
        toUserId: await account(),
      })
      .returning({
        affinity: appAffinityEdges.affinity,
        lastEventAt: appAffinityEdges.lastEventAt,
        eventCount: appAffinityEdges.eventCount,
      });

    // `now()` here would silently claim a fold that never happened, and the
    // scorer decays from this column on every read.
    expect(row.lastEventAt).toBeNull();
    expect(row.affinity).toBe(0);
    expect(row.eventCount).toBe(0);
  });
});

describe('app_user_signals', () => {
  it('bounds `interest_score` to [0, 1]', async () => {
    const applicationId = await application();
    const error = await rejection(
      getDb()
        .insert(appUserSignals)
        .values({ applicationId, userId: await account(), interestScore: 1.5 })
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('allows a NEGATIVE endorsement score', async () => {
    // Deliberately unconstrained: a `remove` subtracts the weight that was
    // added, and float arithmetic can leave a small negative residue after an
    // add/remove cycle. A `>= 0` CHECK here would reject a correct write.
    const [row] = await getDb()
      .insert(appUserSignals)
      .values({
        applicationId: await application(),
        userId: await account(),
        endorsementScore: -0.0000001,
      })
      .returning({ endorsementScore: appUserSignals.endorsementScore });

    expect(row.endorsementScore).toBeLessThan(0);
  });

  it('does not carry `endorsement_count`', async () => {
    // The column is DROPPED: nothing read it, and `count(*)` over
    // `app_endorsement_edges` is a direct hit on that table's existing index.
    // Asserting its absence is what stops it being reintroduced by habit.
    expect(Object.keys(getTableColumns(appUserSignals))).not.toContain('endorsementCount');

    const rows = await getDb().execute<{ column_name: string }>(sql`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'app_user_signals'
    `);
    expect(rows.map((row) => row.column_name)).not.toContain('endorsement_count');
    // Vacuity floor: the query really did read this table's columns.
    expect(rows.map((row) => row.column_name)).toContain('endorsement_score');
  });
});

describe('account_members', () => {
  it('holds at most one membership row per (account, member)', async () => {
    const accountId = await account();
    const memberUserId = await account();
    await getDb().insert(accountMembers).values({ accountId, memberUserId, role: 'admin' });

    const error = await rejection(
      getDb().insert(accountMembers).values({ accountId, memberUserId, role: 'viewer' })
    );
    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
  });

  it('does not carry `permissions`', async () => {
    // Derived from `role` at every write site, and re-derived by the serializer
    // — see the header of `accountMembers.ts`.
    expect(Object.keys(getTableColumns(accountMembers))).not.toContain('permissions');

    const rows = await getDb().execute<{ column_name: string }>(sql`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'account_members'
    `);
    expect(rows.map((row) => row.column_name)).not.toContain('permissions');
    expect(rows.map((row) => row.column_name)).toContain('role');
  });

  it('keeps a membership when its INVITER is erased', async () => {
    const accountId = await account();
    const memberUserId = await account();
    const invitedByUserId = await account();
    const [row] = await getDb()
      .insert(accountMembers)
      .values({ accountId, memberUserId, role: 'developer', invitedByUserId })
      .returning({ id: accountMembers.id });

    await getDb().delete(users).where(eq(users.id, invitedByUserId));

    const [after] = await getDb()
      .select({ invitedByUserId: accountMembers.invitedByUserId })
      .from(accountMembers)
      .where(eq(accountMembers.id, row.id));

    expect(after.invitedByUserId).toBeNull();
  });
});

describe('api_key_usage_events', () => {
  it('records the request instant as `created_at` and has no `updated_at`', async () => {
    const rows = await getDb().execute<{ column_name: string }>(sql`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'api_key_usage_events'
    `);
    const names = rows.map((row) => row.column_name);

    expect(names).toContain('created_at');
    // The absence IS the append-only contract.
    expect(names).not.toContain('updated_at');
    // And the Mongoose field name does not travel — see the file header.
    expect(names).not.toContain('timestamp');
    // #972 workstream 2.3 dropped `api_key_id` together with the
    // `developer_api_keys` table it referenced. Asserted against the MIGRATED
    // database, because that is the one thing the schema declaration cannot
    // prove: deleting the column from the TypeScript makes every functional test
    // here pass whether or not `0047` ever reached a database.
    expect(names).not.toContain('api_key_id');
  });

  it('rejects an impossible status code or negative consumption', async () => {
    const userId = await account();
    const base = { userId, endpoint: '/v1/chat', method: 'POST' } as const;

    const badStatus = await rejection(
      getDb().insert(apiKeyUsageEvents).values({ ...base, statusCode: 42 })
    );
    expect(pgErrorCode(badStatus)).toBe(CHECK_VIOLATION);

    const badCredits = await rejection(
      getDb().insert(apiKeyUsageEvents).values({ ...base, statusCode: 200, creditsUsed: -1 })
    );
    expect(pgErrorCode(badCredits)).toBe(CHECK_VIOLATION);
  });

  it('keeps fractional credits and a fractional response time', async () => {
    const [row] = await getDb()
      .insert(apiKeyUsageEvents)
      .values({
        userId: await account(),
        endpoint: '/v1/chat',
        method: 'POST',
        statusCode: 200,
        creditsUsed: 0.25,
        responseTime: 12.5,
        tokensUsed: 1024,
      })
      .returning();

    // `credits_used` is summed for billing and `response_time` is averaged, so
    // an integer column here would silently truncate both.
    expect(row.creditsUsed).toBeCloseTo(0.25);
    expect(row.responseTime).toBeCloseTo(12.5);
    expect(row.tokensUsed).toBe(1024);
    expect(row.authType).toBe('api_key');
  });

  it('drops a usage row when its APPLICATION is deleted rather than reclassifying it', async () => {
    const userId = await account();
    const applicationId = await application();

    await getDb().insert(apiKeyUsageEvents).values({
      applicationId,
      userId,
      endpoint: '/v1/chat',
      method: 'POST',
      statusCode: 200,
    });

    await getDb().delete(applications).where(eq(applications.id, applicationId));

    const remaining = await getDb()
      .select({ id: apiKeyUsageEvents.id })
      .from(apiKeyUsageEvents)
      .where(eq(apiKeyUsageEvents.userId, userId));

    // `SET NULL` would leave the row attributed to no application, which the
    // per-application aggregate would then read as unattributed traffic.
    expect(remaining).toEqual([]);
  });
});

describe('api_key_usage_events — the 90-day Mongo TTL, moved', () => {
  it('is registered for sweeping with the retention Mongo enforced', () => {
    const target = EXPIRY_SWEEP_TARGETS.find(
      (entry) => getTableName(entry.table) === 'api_key_usage_events'
    );

    expect(target).toBeDefined();
    // Written out rather than derived from the schema constant: deriving it
    // would make the assertion tautological, and 90 days is the number
    // `ApiKeyUsage.ts`'s TTL index states.
    expect(target?.retentionSeconds).toBe(90 * 24 * 60 * 60);
    expect(sqlColumnName(target?.column ?? apiKeyUsageEvents.createdAt)).toBe('created_at');
  });

  it('deletes a row past the retention and keeps one inside it', async () => {
    const target = EXPIRY_SWEEP_TARGETS.find(
      (entry) => getTableName(entry.table) === 'api_key_usage_events'
    );
    if (!target) throw new Error('api_key_usage_events is not registered for sweeping');

    const userId = await account();
    const dayMs = 24 * 60 * 60 * 1000;
    await getDb().insert(apiKeyUsageEvents).values([
      {
        userId,
        endpoint: '/v1/stale',
        method: 'GET',
        statusCode: 200,
        createdAt: new Date(Date.now() - 91 * dayMs),
      },
      {
        userId,
        endpoint: '/v1/fresh',
        method: 'GET',
        statusCode: 200,
        createdAt: new Date(Date.now() - 89 * dayMs),
      },
    ]);

    await sweepExpiredRows(getDb(), target);

    const remaining = await getDb()
      .select({ endpoint: apiKeyUsageEvents.endpoint })
      .from(apiKeyUsageEvents)
      .where(eq(apiKeyUsageEvents.userId, userId));

    expect(remaining.map((row) => row.endpoint)).toEqual(['/v1/fresh']);
  });
});

describe('application_moderation_trust', () => {
  it('holds exactly one standing per application, defaulting to a closed gate', async () => {
    const applicationId = await application();
    const [row] = await getDb()
      .insert(applicationModerationTrust)
      .values({ applicationId })
      .returning();

    expect(row.standing).toBe('sandbox');
    expect(row.globalReputationEffectsAllowed).toBe(false);

    const error = await rejection(
      getDb().insert(applicationModerationTrust).values({ applicationId })
    );
    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
  });

  it('bounds every score to [0, 1]', async () => {
    const error = await rejection(
      getDb()
        .insert(applicationModerationTrust)
        .values({ applicationId: await application(), evidenceIntegrity: 1.2 })
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });
});

describe('app_grants', () => {
  it('holds one grant per (user, application)', async () => {
    const userId = await account();
    const applicationId = await application();
    const [row] = await getDb().insert(appGrants).values({ userId, applicationId }).returning();

    expect(row.scopes).toEqual([]);
    expect(row.firstGrantedAt).toBeInstanceOf(Date);
    expect(row.lastUsedAt).toBeInstanceOf(Date);

    const error = await rejection(getDb().insert(appGrants).values({ userId, applicationId }));
    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
  });

  it('records a scope the platform does not grant', async () => {
    // Deliberately unconstrained: a grant records what the USER consented to,
    // so retiring a scope from the vocabulary must not make history unwritable.
    await expect(
      getDb()
        .insert(appGrants)
        .values({
          userId: await account(),
          applicationId: await application(),
          scopes: ['some:retired:scope'],
        })
    ).resolves.toBeDefined();
  });
});
