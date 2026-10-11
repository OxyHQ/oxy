/**
 * retire-service-credentials.ts, run for real against PostgreSQL as its one-off
 * task runs it: a separate `bun` process with DATABASE_URL and its inputs in the
 * environment. Revocation, its audit event and every refusal are properties of
 * the script's real transaction, which a mocked database would not hold.
 */

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applicationCredentialAuditEvents } from '../../db/schema/applicationCredentialAuditEvents';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { users } from '../../db/schema/users';
import { createTestDatabase, dropTestDatabase } from '../../db/testDatabase';

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
let ownDatabaseUrl: string | undefined;
let owner: string;
let applicationId: string;

jest.setTimeout(120_000);

interface Run {
  readonly status: number | null;
  readonly result: Record<string, unknown> | null;
}

function retire(env: Record<string, string>): Run {
  const child = spawnSync('bun', ['run', 'scripts/retire-service-credentials.ts'], {
    cwd: `${__dirname}/../../..`,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      DATABASE_URL: process.env.DATABASE_URL ?? '',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      ACTOR_USER_ID: owner,
      REASON: 'retired for workload identity',
      ...env,
    },
    encoding: 'utf8',
    timeout: 120_000,
  });
  const line = child.stdout
    .split('\n')
    .find((candidate) => candidate.startsWith('RETIRE_SERVICE_CREDENTIALS_RESULT='));
  return {
    status: child.status,
    result: line ? JSON.parse(line.slice('RETIRE_SERVICE_CREDENTIALS_RESULT='.length)) : null,
  };
}

async function credential(
  type: 'service' | 'public' | 'confidential',
  lastUsedAt: Date | null = null,
): Promise<string> {
  const id = randomUUID();
  await getDb()
    .insert(applicationCredentials)
    .values({
      id,
      applicationId,
      name: `fixture ${id}`,
      publicKey: `oxy_dk_${id.replace(/-/g, '')}`,
      secretHash: type === 'public' ? null : 'd'.repeat(64),
      type,
      environment: 'production',
      scopes: ['user:read'],
      status: 'active',
      createdByUserId: owner,
      lastUsedAt,
    });
  return id;
}

async function statuses(ids: string[]): Promise<Record<string, string>> {
  const rows = await getDb()
    .select({ id: applicationCredentials.id, status: applicationCredentials.status })
    .from(applicationCredentials)
    .where(inArray(applicationCredentials.id, ids));
  return Object.fromEntries(rows.map((row) => [row.id, row.status]));
}

beforeAll(async () => {
  ownDatabaseUrl = await createTestDatabase();
  await connectPostgres();
  const [user] = await getDb().insert(users).values({ color: 'teal' }).returning();
  owner = user.id;
  const [app] = await getDb()
    .insert(applications)
    .values({
      name: `retire-${randomUUID()}`,
      type: 'first_party',
      status: 'active',
      ownerAccountId: owner,
      scopes: ['user:read'],
    })
    .returning();
  applicationId = app.id;
});

afterAll(async () => {
  try {
    await closePostgres();
  } finally {
    try {
      if (ownDatabaseUrl) await dropTestDatabase(ownDatabaseUrl);
    } finally {
      if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
    }
  }
});

describe('retire-service-credentials.ts', () => {
  it('dry-runs without writing, then revokes with an audit event, then is a no-op', async () => {
    const idle = await credential('service', new Date(Date.now() - 2 * 3_600_000));
    const never = await credential('service');

    const dry = retire({ CREDENTIAL_IDS: `${idle},${never}` });
    expect(dry).toEqual({
      status: 0,
      result: {
        mode: 'dry-run',
        credentials: [
          { id: idle, disposition: 'revoke' },
          { id: never, disposition: 'revoke' },
        ],
      },
    });
    expect(await statuses([idle, never])).toEqual({ [idle]: 'active', [never]: 'active' });

    const apply = retire({ CREDENTIAL_IDS: `${idle},${never}`, APPLY: 'true' });
    expect(apply.status).toBe(0);
    expect(await statuses([idle, never])).toEqual({ [idle]: 'revoked', [never]: 'revoked' });
    const events = await getDb()
      .select({
        credentialId: applicationCredentialAuditEvents.credentialId,
        eventType: applicationCredentialAuditEvents.eventType,
        actorUserId: applicationCredentialAuditEvents.actorUserId,
      })
      .from(applicationCredentialAuditEvents)
      .where(inArray(applicationCredentialAuditEvents.credentialId, [idle, never]));
    expect(events).toHaveLength(2);
    expect(
      events.every((event) => event.eventType === 'revoked' && event.actorUserId === owner),
    ).toBe(true);

    const rerun = retire({ CREDENTIAL_IDS: idle, APPLY: 'true' });
    expect(rerun.result).toEqual({
      mode: 'apply',
      credentials: [{ id: idle, disposition: 'already_revoked' }],
    });
  });

  it('revokes an unused confidential OAuth client too', async () => {
    const client = await credential('confidential');
    const run = retire({ CREDENTIAL_IDS: client, APPLY: 'true' });
    expect(run.result).toEqual({
      mode: 'apply',
      credentials: [{ id: client, disposition: 'revoke' }],
    });
    expect((await statuses([client]))[client]).toBe('revoked');
  });

  it('refuses the whole batch when one credential was used recently', async () => {
    const idle = await credential('service');
    const recent = await credential('service', new Date(Date.now() - 5 * 60_000));

    const run = retire({ CREDENTIAL_IDS: `${idle},${recent}`, APPLY: 'true' });
    expect(run.status).toBe(1);
    expect(String(run.result?.error)).toContain(`Credential ${recent} was used at`);
    expect(await statuses([idle, recent])).toEqual({ [idle]: 'active', [recent]: 'active' });
  });

  it('refuses a credential that is not a service one, and an unknown id', async () => {
    const publicClient = await credential('public');
    const notService = retire({ CREDENTIAL_IDS: publicClient, APPLY: 'true' });
    expect(notService.status).toBe(1);
    expect(String(notService.result?.error)).toContain(
      'is a public credential, not a secret-bearing one',
    );
    expect((await statuses([publicClient]))[publicClient]).toBe('active');

    const unknown = randomUUID();
    const missing = retire({ CREDENTIAL_IDS: unknown, APPLY: 'true' });
    expect(missing.status).toBe(1);
    expect(String(missing.result?.error)).toContain(`Credential ${unknown} does not exist`);
  });

  it('requires an actor and a reason', async () => {
    const id = await credential('service');
    expect(retire({ CREDENTIAL_IDS: id, ACTOR_USER_ID: '' }).status).toBe(1);
    expect(retire({ CREDENTIAL_IDS: id, REASON: '' }).status).toBe(1);
    const [row] = await getDb()
      .select({ status: applicationCredentials.status })
      .from(applicationCredentials)
      .where(eq(applicationCredentials.id, id));
    expect(row.status).toBe('active');
  });
});
