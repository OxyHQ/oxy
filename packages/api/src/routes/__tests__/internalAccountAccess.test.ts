/**
 * `GET /internal/accounts/:accountId/access/:userId`, over real HTTP against a
 * real Postgres, with the REAL service-token middleware, the REAL trust gate and
 * the REAL account service.
 *
 * The endpoint answers "may this person act for that account" for a service
 * that holds no session of theirs — the check Mention and Oxy Move make before
 * publishing to a channel on a member's behalf. Every verdict below has a real
 * row behind it, and every "no" is seeded next to a row that would have said
 * "yes" under a looser rule (an invited or removed member, an archived account
 * WITH an active member, an unclaimed directory account WITH one), so a gate
 * that stopped checking the property under test turns its case red.
 *
 * Only the rate limiter and the logger are mocked; the logger mock is also how
 * the suite proves the person asked about never reaches a log line.
 */

import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

/** The middleware verifies the token itself, so the real JWT must be used. */
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));

jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { accountAccessVerdictSchema } from '@oxy.so/contracts';
import { eq } from 'drizzle-orm';
import { insertAccountFixtures } from '../../db/__fixtures__/accountIdentity';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { signServiceTokenEd25519 } from '../../config/serviceTokenSigning';
import { accountMembers } from '../../db/schema/accountMembers';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { organizationProfiles } from '../../db/schema/organizationProfiles';
import { userAncestors } from '../../db/schema/userAncestors';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import { ACCOUNT_MEMBERSHIP_READ_SCOPE } from '../../utils/applicationScopes';
import { permissionsForAccountRole } from '../../utils/accountRoles';
import { logger } from '../../utils/logger';
import internalRouter from '../internal';

type AccountKind = 'personal' | 'organization' | 'project' | 'bot' | 'channel';

interface AccessResponse {
  status: number;
  body: { data?: unknown; error?: string; message?: string };
}

interface SeededApp {
  appId: string;
  credentialId: string;
  ownerAccountId: string;
  scopes: string[];
}

let server: http.Server;

async function account(
  kind: AccountKind,
  options: { status?: 'active' | 'archived'; parentAccountId?: string } = {},
): Promise<string> {
  const [row] = await insertAccountFixtures(
    {
      username: `acct-${randomUUID().slice(0, 18)}`,
      kind,
      accountStatus: options.status ?? 'active',
      ...(options.parentAccountId
        ? { parentAccountId: options.parentAccountId, rootAccountId: options.parentAccountId }
        : {}),
    },
    { id: users.id },
  );
  if (options.parentAccountId) {
    await getDb()
      .insert(userAncestors)
      .values({ userId: row.id, ancestorId: options.parentAccountId, depth: 0 });
  }
  return row.id;
}

function human(): Promise<string> {
  return account('personal');
}

async function member(
  accountId: string,
  memberUserId: string,
  role: 'owner' | 'admin' | 'editor' | 'viewer',
  extra: {
    status?: 'active' | 'invited' | 'removed';
    inherit?: boolean;
    permissionRevokes?: string[];
  } = {},
): Promise<void> {
  await getDb()
    .insert(accountMembers)
    .values({
      accountId,
      memberUserId,
      role,
      status: extra.status ?? 'active',
      inherit: extra.inherit ?? true,
      permissionRevokes: extra.permissionRevokes ?? [],
    });
}

async function seedApp(
  options: { type?: 'internal' | 'third_party'; scopes?: string[] } = {},
): Promise<SeededApp> {
  const scopes = options.scopes ?? ['user:read', ACCOUNT_MEMBERSHIP_READ_SCOPE];
  const ownerAccountId = await human();
  const [app] = await getDb()
    .insert(applications)
    .values({
      name: `App ${randomUUID()}`,
      type: options.type ?? 'internal',
      status: 'active',
      scopes,
      ownerAccountId,
    })
    .returning({ id: applications.id });
  const [credential] = await getDb()
    .insert(applicationCredentials)
    .values({
      applicationId: app.id,
      name: 'service',
      publicKey: `oxy_dk_${randomUUID().replace(/-/g, '')}`,
      type: 'service',
      environment: 'production',
    })
    .returning({ id: applicationCredentials.id });
  return { appId: app.id, credentialId: credential.id, ownerAccountId, scopes };
}

function serviceToken(app: SeededApp): string {
  const issuedAt = Math.floor(Date.now() / 1_000);
  return signServiceTokenEd25519({
    type: 'service',
    appId: app.appId,
    appName: 'Oxy Move',
    credentialId: app.credentialId,
    ownerAccountId: app.ownerAccountId,
    environment: 'production',
    scopes: app.scopes,
    iss: 'oxy-auth',
    aud: 'oxy-api',
    iat: issuedAt,
    exp: issuedAt + 300,
  });
}

function accessFor(accountId: string, userId: string, token: string): Promise<AccessResponse> {
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'GET',
        host: '127.0.0.1',
        port: address.port,
        path: `/internal/accounts/${encodeURIComponent(accountId)}/access/${encodeURIComponent(userId)}`,
        headers: { authorization: `Bearer ${token}`, connection: 'close' },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: raw.length > 0 ? JSON.parse(raw) : {} }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

let trusted: SeededApp;

/** A verdict from the trusted, scoped app, checked against the published contract. */
async function verdict(accountId: string, userId: string) {
  const res = await accessFor(accountId, userId, serviceToken(trusted));
  expect(res.status).toBe(200);
  return accountAccessVerdictSchema.parse(res.body.data);
}

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/internal', internalRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  trusted = await seedApp();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePostgres();
});

beforeEach(() => {
  jest.mocked(logger.info).mockClear();
});

describe('who may ask', () => {
  it('refuses an application that is not platform-trusted, even holding the scope', async () => {
    const outsider = await seedApp({ type: 'third_party' });
    const channel = await account('channel');
    const person = await human();
    await member(channel, person, 'editor');

    const res = await accessFor(channel, person, serviceToken(outsider));

    expect(res.status).toBe(403);
    expect(res.body.data).toBeUndefined();
  });

  it('refuses a trusted application without accounts:membership:read', async () => {
    const unscoped = await seedApp({ scopes: ['user:read', 'accounts:act-as-session'] });
    const channel = await account('channel');
    const person = await human();
    await member(channel, person, 'editor');

    const res = await accessFor(channel, person, serviceToken(unscoped));

    expect(res.status).toBe(403);
    expect(res.body.message).toContain(ACCOUNT_MEMBERSHIP_READ_SCOPE);
    expect(res.body.data).toBeUndefined();
  });

  it('refuses a request with no service token at all', async () => {
    const res = await accessFor(await account('channel'), await human(), 'not-a-token');
    expect(res.status).toBe(401);
  });
});

describe('verdicts', () => {
  it('a direct member: their role and EFFECTIVE permissions, source direct', async () => {
    const channel = await account('channel');
    const person = await human();
    await member(channel, person, 'editor', { permissionRevokes: ['members:read'] });

    const answer = await verdict(channel, person);

    expect(answer).toEqual({
      accountId: channel,
      kind: 'channel',
      access: {
        role: 'editor',
        permissions: permissionsForAccountRole('editor').filter((p) => p !== 'members:read'),
        status: 'active',
        source: 'direct',
      },
    });
    // The per-member revoke is honoured, not only the role's baseline.
    expect(permissionsForAccountRole('editor')).toContain('members:read');
    expect(answer.access?.permissions).not.toContain('members:read');
  });

  it('an inherited member: a cascading row on the parent, source inherited', async () => {
    const org = await account('organization');
    const channel = await account('channel', { parentAccountId: org });
    const person = await human();
    await member(org, person, 'admin', { inherit: true });

    const answer = await verdict(channel, person);

    expect(answer.kind).toBe('channel');
    expect(answer.access).toEqual(
      expect.objectContaining({ role: 'admin', status: 'active', source: 'inherited' }),
    );
  });

  it('a parent row that does not cascade grants nothing', async () => {
    const org = await account('organization');
    const channel = await account('channel', { parentAccountId: org });
    const person = await human();
    await member(org, person, 'admin', { inherit: false });

    expect((await verdict(channel, person)).access).toBeNull();
  });

  it('a removed member: no access', async () => {
    const channel = await account('channel');
    const person = await human();
    await member(channel, person, 'editor', { status: 'removed' });

    expect(await verdict(channel, person)).toEqual({
      accountId: channel,
      kind: 'channel',
      access: null,
    });
  });

  it('an invited member who has not accepted: no access', async () => {
    const channel = await account('channel');
    const person = await human();
    await member(channel, person, 'editor', { status: 'invited' });

    expect((await verdict(channel, person)).access).toBeNull();
  });

  it('a stranger: no access', async () => {
    expect((await verdict(await account('channel'), await human())).access).toBeNull();
  });

  it('an archived account: no access, even for an active member', async () => {
    const channel = await account('channel', { status: 'archived' });
    const person = await human();
    await member(channel, person, 'owner');

    expect(await verdict(channel, person)).toEqual({
      accountId: channel,
      kind: 'channel',
      access: null,
    });
  });

  it('an unknown account: no kind and no access', async () => {
    const missing = `missing-${randomUUID()}`;

    expect(await verdict(missing, await human())).toEqual({
      accountId: missing,
      kind: null,
      access: null,
    });
  });

  it('a personal account asked about itself: its owner, source self', async () => {
    const person = await human();

    expect(await verdict(person, person)).toEqual({
      accountId: person,
      kind: 'personal',
      access: {
        role: 'owner',
        permissions: permissionsForAccountRole('owner'),
        status: 'active',
        source: 'self',
      },
    });
  });

  it("somebody else's personal account: no access", async () => {
    expect((await verdict(await human(), await human())).access).toBeNull();
  });

  it('an unclaimed directory account: no access, even for an active member', async () => {
    const org = await account('organization');
    const person = await human();
    await member(org, person, 'owner');
    // The fixture seeds a CLAIMED profile; this is the positive control.
    expect((await verdict(org, person)).access?.role).toBe('owner');

    await getDb()
      .update(organizationProfiles)
      .set({ claimStatus: 'unclaimed' })
      .where(eq(organizationProfiles.accountId, org));

    expect(await verdict(org, person)).toEqual({
      accountId: org,
      kind: 'organization',
      access: null,
    });
  });
});

describe('the audit line', () => {
  it('records caller, account and outcome, and never the person asked about', async () => {
    const channel = await account('channel');
    const person = await human();
    await member(channel, person, 'editor');

    await verdict(channel, person);
    await verdict(channel, await human());

    const lines = jest
      .mocked(logger.info)
      .mock.calls.filter(([message]) => message === '[internal] account access verdict');
    expect(lines.map(([, meta]) => meta)).toEqual([
      { callerAppId: trusted.appId, accountId: channel, authorized: true },
      { callerAppId: trusted.appId, accountId: channel, authorized: false },
    ]);
    expect(JSON.stringify(jest.mocked(logger.info).mock.calls)).not.toContain(person);
  });
});
