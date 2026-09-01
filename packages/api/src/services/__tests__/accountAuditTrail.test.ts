/**
 * The account-scoped audit union, against a REAL Postgres.
 *
 * Three claims are load-bearing here, and each has a control beside it because
 * "the row was absent" and "the fixture never landed" are the same observation
 * from inside a test:
 *
 *  1. **The union is account-scoped in BOTH arms.** A second account's credential
 *     events and connection events are both withheld — paired with the same read
 *     returning the first account's rows from both sources, so a query that
 *     matched nothing could not pass.
 *  2. **The cursor does not skip a row at a tie.** Two events written at the SAME
 *     instant in DIFFERENT tables are paged across one at a time, and the union of
 *     the pages is asserted to be the whole trail with nothing lost and nothing
 *     repeated. A cursor on `created_at` alone passes every other test in this
 *     file and fails this one.
 *  3. **The actor is discriminated per source.** A refused credential validation
 *     resolves to `none` and NOT to `service`, which is what a nullable
 *     `actorUserId` flattened across the two sources would have produced.
 *
 * Every fixture owns its identifiers, so nothing here reads or counts a sibling
 * file's rows.
 */

import { createHash, randomUUID } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import {
  applicationCredentialAuditEvents,
  applicationCredentials,
  applications,
  inferenceProviderConnectionAuditEvents,
  inferenceProviderConnections,
  inferenceProviders,
  users,
} from '../../db/schema';
import {
  decodeAccountAuditCursor,
  encodeAccountAuditCursor,
  listAccountAuditTrail,
} from '../accountAuditTrail.service';

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

function suffix(): string {
  return randomUUID().replace(/-/g, '').slice(0, 10);
}

async function insertAccount(): Promise<string> {
  const tag = suffix();
  const [row] = await getDb()
    .insert(users)
    .values({ username: `aud-${tag}`, email: `aud-${tag}@example.test` })
    .returning({ id: users.id });
  return row.id;
}

async function insertApplication(ownerAccountId: string): Promise<string> {
  const [row] = await getDb()
    .insert(applications)
    .values({ name: `Aud ${suffix()}`, ownerAccountId })
    .returning({ id: applications.id });
  return row.id;
}

async function insertCredential(applicationId: string): Promise<string> {
  const [row] = await getDb()
    .insert(applicationCredentials)
    .values({
      applicationId,
      name: `key ${suffix()}`,
      publicKey: `oxy_dk_${suffix()}`,
      // A `confidential` client rather than `machine`: the two token halves are
      // a biconditional CHECK on `machine`, and this row exists only as the FK
      // target the audit rows point at.
      type: 'confidential',
      environment: 'development',
    })
    .returning({ id: applicationCredentials.id });
  return row.id;
}

/** A credential audit row. `createdAt` is explicit so ties can be constructed. */
async function insertCredentialEvent(options: {
  applicationId: string;
  credentialId: string;
  eventType: 'created' | 'rotated' | 'revoked' | 'validation_failed';
  reason?: 'scope_missing' | null;
  actorUserId?: string | null;
  createdAt: Date;
}): Promise<string> {
  const [row] = await getDb()
    .insert(applicationCredentialAuditEvents)
    .values({
      applicationId: options.applicationId,
      credentialId: options.credentialId,
      eventType: options.eventType,
      reason: options.reason ?? null,
      actorUserId: options.actorUserId ?? null,
      environment: 'development',
      createdAt: options.createdAt,
    })
    .returning({ id: applicationCredentialAuditEvents.id });
  return row.id;
}

async function insertConnection(ownerAccountId: string, applicationId: string): Promise<string> {
  const slug = `prv${suffix()}`;
  await getDb()
    .insert(inferenceProviders)
    .values({
      slug,
      displayName: 'Fixture Provider',
      kind: 'customer_byok',
      retainsPayloads: false,
      retentionDays: 0,
      trainsOnCustomerData: false,
      zeroDataRetentionAvailable: true,
    });
  // The id is minted HERE rather than by the column default, mirroring
  // `inferenceProviderConnection.service.ts`: the partition CHECK requires
  // `secret_ref` to END with `/<environment>/<ownerAccountId>/<id>`, which a
  // database-side default could only satisfy after the insert.
  const connectionId = uuidv7();
  const [row] = await getDb()
    .insert(inferenceProviderConnections)
    .values({
      id: connectionId,
      ownerAccountId,
      applicationId,
      // `scope_kind` is NOT NULL and the presence of `application_id` is a
      // biconditional on it, so an application-scoped connection names both.
      scopeKind: 'application',
      provider: slug,
      environment: 'development',
      secretRef: `secretsmanager:oxy/inference/byok/development/${ownerAccountId}/${connectionId}`,
      // `key_prefix` is 1..12 chars and `fingerprint` must be 64 lowercase hex —
      // a SHA-256 digest and nothing else. The fixture satisfies both rather than
      // working around them.
      keyPrefix: `sk-${suffix()}`.slice(0, 12),
      fingerprint: createHash('sha256').update(suffix()).digest('hex'),
      status: 'active',
      validationState: 'valid',
    })
    .returning({ id: inferenceProviderConnections.id });
  return row.id;
}

async function insertConnectionEvent(options: {
  connectionId: string;
  ownerAccountId: string;
  eventType: 'created' | 'validated' | 'rotated' | 'used' | 'disabled' | 'enabled' | 'revoked';
  actorKind?: 'user' | 'service' | 'platform' | null;
  actorUserId?: string | null;
  createdAt: Date;
}): Promise<string> {
  const [row] = await getDb()
    .insert(inferenceProviderConnectionAuditEvents)
    .values({
      connectionId: options.connectionId,
      ownerAccountId: options.ownerAccountId,
      eventType: options.eventType,
      actorKind: options.actorKind ?? null,
      actorUserId: options.actorUserId ?? null,
      environment: 'development',
      createdAt: options.createdAt,
    })
    .returning({ id: inferenceProviderConnectionAuditEvents.id });
  return row.id;
}

/* -------------------------------------------------------------------------- */
/*  1. Account scoping, in both arms                                          */
/* -------------------------------------------------------------------------- */

describe('the union is scoped to one account in both arms', () => {
  it('withholds another account’s credential AND connection events, and serves its own', async () => {
    const mine = await insertAccount();
    const theirs = await insertAccount();

    const myApp = await insertApplication(mine);
    const myCredential = await insertCredential(myApp);
    const myConnection = await insertConnection(mine, myApp);
    await insertCredentialEvent({
      applicationId: myApp,
      credentialId: myCredential,
      eventType: 'created',
      actorUserId: mine,
      createdAt: new Date('2026-08-18T10:00:00.000Z'),
    });
    await insertConnectionEvent({
      connectionId: myConnection,
      ownerAccountId: mine,
      eventType: 'created',
      actorKind: 'user',
      actorUserId: mine,
      createdAt: new Date('2026-08-18T10:00:01.000Z'),
    });

    const theirApp = await insertApplication(theirs);
    const theirCredential = await insertCredential(theirApp);
    const theirConnection = await insertConnection(theirs, theirApp);
    await insertCredentialEvent({
      applicationId: theirApp,
      credentialId: theirCredential,
      eventType: 'created',
      actorUserId: theirs,
      createdAt: new Date('2026-08-18T10:00:02.000Z'),
    });
    await insertConnectionEvent({
      connectionId: theirConnection,
      ownerAccountId: theirs,
      eventType: 'created',
      actorKind: 'user',
      actorUserId: theirs,
      createdAt: new Date('2026-08-18T10:00:03.000Z'),
    });

    const page = await listAccountAuditTrail(mine, { limit: 50 });
    const subjects = page.entries.map((entry) => entry.subjectId);

    // POSITIVE CONTROL: both of MY sources are present. Without this, a query
    // that returned nothing would satisfy the two exclusions below.
    expect(subjects).toContain(myCredential);
    expect(subjects).toContain(myConnection);
    expect(page.entries.map((entry) => entry.source).sort()).toEqual([
      'application_credential',
      'provider_connection',
    ]);

    // The claim, for each arm separately — a scoping bug in ONE arm is the
    // realistic failure, and asserting only the total would hide it.
    expect(subjects).not.toContain(theirCredential);
    expect(subjects).not.toContain(theirConnection);
  });
});

/* -------------------------------------------------------------------------- */
/*  2. The cursor, across a cross-source tie                                  */
/* -------------------------------------------------------------------------- */

describe('the cursor does not skip a row when two sources share an instant', () => {
  it('pages one at a time across a tie and loses nothing', async () => {
    const account = await insertAccount();
    const app = await insertApplication(account);
    const credential = await insertCredential(app);
    const connection = await insertConnection(account, app);

    // THE CASE THAT MATTERS: one identical instant, one row in each table. A
    // cursor keyed on `created_at` alone cannot distinguish them, so paging past
    // the first silently drops the second.
    const tie = new Date('2026-08-18T11:00:00.000Z');
    await insertCredentialEvent({
      applicationId: app,
      credentialId: credential,
      eventType: 'created',
      actorUserId: account,
      createdAt: tie,
    });
    await insertConnectionEvent({
      connectionId: connection,
      ownerAccountId: account,
      eventType: 'created',
      actorKind: 'user',
      actorUserId: account,
      createdAt: tie,
    });
    // A third, strictly older, so the walk has somewhere to continue to and the
    // test is not measuring only the boundary.
    await insertConnectionEvent({
      connectionId: connection,
      ownerAccountId: account,
      eventType: 'used',
      actorKind: 'service',
      createdAt: new Date('2026-08-18T10:59:59.000Z'),
    });

    const whole = await listAccountAuditTrail(account, { limit: 50 });
    expect(whole.entries).toHaveLength(3);
    expect(whole.nextCursor).toBeNull();

    // Walk it one row per page. Every row must appear exactly once, in the same
    // order the unpaged read produced.
    const walked: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await listAccountAuditTrail(account, { limit: 1, cursor });
      walked.push(...page.entries.map((entry) => `${entry.source}:${entry.eventType}`));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }

    expect(walked).toEqual(
      whole.entries.map((entry) => `${entry.source}:${entry.eventType}`)
    );
    // Stated separately from the ordering, because a walk that repeated a row
    // could still be ordered.
    expect(new Set(walked).size).toBe(3);
  });

  it('orders a tie deterministically, the same way on every read', async () => {
    const account = await insertAccount();
    const app = await insertApplication(account);
    const credential = await insertCredential(app);
    const connection = await insertConnection(account, app);

    const tie = new Date('2026-08-18T12:00:00.000Z');
    await insertCredentialEvent({
      applicationId: app,
      credentialId: credential,
      eventType: 'created',
      actorUserId: account,
      createdAt: tie,
    });
    await insertConnectionEvent({
      connectionId: connection,
      ownerAccountId: account,
      eventType: 'created',
      actorKind: 'user',
      actorUserId: account,
      createdAt: tie,
    });

    const first = await listAccountAuditTrail(account, { limit: 50 });
    const second = await listAccountAuditTrail(account, { limit: 50 });
    expect(first.entries.map((entry) => entry.source)).toEqual(
      second.entries.map((entry) => entry.source)
    );
    // `source desc` is the declared tiebreak — every component of the sort key
    // descends, because the cursor is a row-value comparison and that only
    // expresses a keyset when the whole key sorts one way.
    expect(first.entries[0].source).toBe('provider_connection');
  });
});

/* -------------------------------------------------------------------------- */
/*  3. The actor is discriminated per source                                  */
/* -------------------------------------------------------------------------- */

describe('the actor keeps the distinction each source can actually make', () => {
  it('reports a refused credential validation as having NO actor, not a service one', async () => {
    const account = await insertAccount();
    const app = await insertApplication(account);
    const credential = await insertCredential(app);
    const connection = await insertConnection(account, app);

    await insertCredentialEvent({
      applicationId: app,
      credentialId: credential,
      eventType: 'validation_failed',
      reason: 'scope_missing',
      actorUserId: null,
      createdAt: new Date('2026-08-18T13:00:02.000Z'),
    });
    await insertCredentialEvent({
      applicationId: app,
      credentialId: credential,
      eventType: 'rotated',
      actorUserId: account,
      createdAt: new Date('2026-08-18T13:00:01.000Z'),
    });
    // A connection event whose actor really IS a service credential — the
    // control that makes the assertion above meaningful, since it proves the
    // `service` arm is reachable at all.
    await insertConnectionEvent({
      connectionId: connection,
      ownerAccountId: account,
      eventType: 'used',
      actorKind: 'service',
      createdAt: new Date('2026-08-18T13:00:00.000Z'),
    });

    const page = await listAccountAuditTrail(account, { limit: 50 });
    const byEvent = new Map(page.entries.map((entry) => [entry.eventType, entry]));

    // Both null-actor rows, told apart. This is the whole point of the
    // discriminated union: a flattened `actorUserId: null` would make these two
    // identical.
    expect(byEvent.get('validation_failed')?.actor).toEqual({ kind: 'none' });
    expect(byEvent.get('used')?.actor).toEqual({ kind: 'service' });

    expect(byEvent.get('rotated')?.actor).toEqual({ kind: 'user', userId: account });
    // The reason rides only on the refusal.
    expect(byEvent.get('validation_failed')?.reason).toBe('scope_missing');
    expect(byEvent.get('rotated')?.reason).toBeNull();
  });

  it('does not guess an actor kind for a connection row written before #1043', async () => {
    const account = await insertAccount();
    const app = await insertApplication(account);
    const connection = await insertConnection(account, app);

    // `actorKind` is nullable for exactly these rows. Guessing `user` from the
    // presence of an id would assert a person acted when the row never said so.
    await insertConnectionEvent({
      connectionId: connection,
      ownerAccountId: account,
      eventType: 'validated',
      actorKind: null,
      actorUserId: null,
      createdAt: new Date('2026-08-18T14:00:00.000Z'),
    });

    const page = await listAccountAuditTrail(account, { limit: 50 });
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0].actor).toEqual({ kind: 'unknown' });
  });
});

/* -------------------------------------------------------------------------- */
/*  4. The cursor itself                                                      */
/* -------------------------------------------------------------------------- */

describe('the cursor is opaque and refuses what it did not issue', () => {
  /**
   * The timestamp survives VERBATIM, microseconds included.
   *
   * This is the assertion that would fail if the cursor were round-tripped
   * through a `Date`: `new Date('…003125+00').toISOString()` is `…003Z`, and a
   * cursor carrying the truncated value silently excludes every row between the
   * truncated millisecond and the true one. Postgres returns microseconds, so
   * the fixture uses the format it actually emits rather than a tidy ISO string.
   */
  it('round-trips a position verbatim, without losing microseconds', () => {
    const cursor = {
      createdAt: '2026-08-18 15:00:00.003125+00',
      source: 'provider_connection' as const,
      id: 'abc123',
    };
    const decoded = decodeAccountAuditCursor(encodeAccountAuditCursor(cursor));
    expect(decoded?.createdAt).toBe('2026-08-18 15:00:00.003125+00');
    expect(decoded?.createdAt).toContain('003125');
    expect(decoded?.source).toBe('provider_connection');
    expect(decoded?.id).toBe('abc123');
  });

  it('returns null for anything it did not issue, rather than throwing', () => {
    // Null rather than a throw: the caller then reads from the start, which is
    // what passing nothing does. Measured — neither the base64url decode nor the
    // Date parse throws on any of these, which is why the function needs no catch.
    for (const bad of ['', 'nonsense', Buffer.from('only|two').toString('base64url')]) {
      expect(decodeAccountAuditCursor(bad)).toBeNull();
    }
    // A well-formed triple naming a source that does not exist is refused too:
    // it would otherwise sort into a position no row can occupy.
    const forged = Buffer.from('2026-08-18T15:00:00.000Z|invented_source|x').toString('base64url');
    expect(decodeAccountAuditCursor(forged)).toBeNull();
  });

  it('reads from the start when handed a cursor it refused', async () => {
    const account = await insertAccount();
    const app = await insertApplication(account);
    const credential = await insertCredential(app);
    await insertCredentialEvent({
      applicationId: app,
      credentialId: credential,
      eventType: 'created',
      actorUserId: account,
      createdAt: new Date('2026-08-18T16:00:00.000Z'),
    });

    const page = await listAccountAuditTrail(account, { limit: 50, cursor: 'not-a-cursor' });
    expect(page.entries).toHaveLength(1);
  });
});
