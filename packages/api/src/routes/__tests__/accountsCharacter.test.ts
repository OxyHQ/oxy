/**
 * `users.character` on the ACCOUNT GRAPH — `POST /accounts`, `PATCH /accounts/:id`
 * and the public serializers.
 *
 * Every `bot` account has a 3D avatar character from the moment it exists, so
 * the platform GENERATES one when the creator names none and KEEPS the one they
 * name. Nobody else carries one: not on create, not on update, not in a payload.
 *
 * The real router over real Postgres with the real `account.service` (see
 * `accountsColor.test.ts` for why the service is not mocked). Each refusal is
 * paired with a request that differs ONLY in the kind or in who is asking.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { avatarCharacterFor, type AvatarCharacter } from '@oxy.so/contracts';

let actingUserId = '';

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (
    req: { user?: { _id: string; id: string } },
    _res: unknown,
    next: () => void,
  ) => {
    req.user = { _id: actingUserId, id: actingUserId };
    next();
  },
  serviceAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../middleware/requireStaff', () => ({ isStaffUser: () => false }));

jest.mock('../../services/session.service', () => ({
  __esModule: true,
  default: { createSession: jest.fn(), getSession: jest.fn() },
}));

jest.mock('../../services/deviceSession.service', () => ({
  __esModule: true,
  default: { addAccount: jest.fn() },
}));

jest.mock('../../utils/socket', () => ({ broadcastDeviceState: jest.fn() }));

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import accountsRouter from '../accounts';
import { errorHandler } from '../../middleware/errorHandler';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { accountMembers } from '../../db/schema/accountMembers';
import { users } from '../../db/schema/users';
import type { AccountRole } from '../../utils/accountRoles';

interface JsonResponse {
  status: number;
  body: {
    message?: string;
    account?: { account?: { character?: AvatarCharacter }; accountId?: string };
  };
}

let server: http.Server;

function uniqueUsername(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString('hex')}`;
}

/** A handle carrying the label a `bot` account's handle must end in. */
function uniqueBotUsername(prefix: string): string {
  return `${uniqueUsername(prefix)}bot`;
}

function send(
  method: 'POST' | 'PATCH',
  path: string,
  payload: Record<string, unknown>,
): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: address.port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: 'Bearer user-token',
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: raw ? (JSON.parse(raw) as JsonResponse['body']) : {},
          });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function seedPersonalAccount(): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ color: 'teal', username: uniqueUsername('person'), kind: 'personal' })
    .returning({ id: users.id });
  return row.id;
}

async function addMember(
  accountId: string,
  memberUserId: string,
  role: AccountRole,
): Promise<void> {
  await getDb().insert(accountMembers).values({
    accountId,
    memberUserId,
    role,
    inherit: true,
    status: 'active',
  });
}

/** A child account of `kind`, owned by `ownerUserId`; a bot is born with a character. */
async function seedChild(
  ownerUserId: string,
  kind: 'bot' | 'project',
  character: AvatarCharacter | null,
): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({
      color: 'teal',
      username: kind === 'bot' ? uniqueBotUsername('seed') : uniqueUsername('seed'),
      kind,
      character,
      parentAccountId: ownerUserId,
      rootAccountId: ownerUserId,
    })
    .returning({ id: users.id });
  await addMember(row.id, ownerUserId, 'owner');
  return row.id;
}

async function storedCharacter(accountId: string): Promise<AvatarCharacter | null> {
  const [row] = await getDb()
    .select({ character: users.character })
    .from(users)
    .where(eq(users.id, accountId));
  return row.character;
}

const GIVEN: AvatarCharacter = { preset: 'alfred', bodyColor: '#ffaa00' };
const EDITED: AvatarCharacter = { shape: 'heart', eyes: 'oval', color: 'coral' };

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/accounts', accountsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePostgres();
});

describe('POST /accounts — a bot is born with a character', () => {
  test('generates one, seeded from the handle, when the caller names none', async () => {
    actingUserId = await seedPersonalAccount();
    const username = uniqueBotUsername('gen');

    const res = await send('POST', '/accounts', { kind: 'bot', username });

    expect(res.status).toBe(201);
    const id = res.body.account?.accountId ?? '';
    expect(await storedCharacter(id)).toEqual(avatarCharacterFor(username));
    // The created account's DTO carries it, so a client paints it without a re-read.
    expect(res.body.account?.account?.character).toEqual(avatarCharacterFor(username));
  });

  test('keeps the character the caller named, lower-casing the hex', async () => {
    actingUserId = await seedPersonalAccount();

    const res = await send('POST', '/accounts', {
      kind: 'bot',
      username: uniqueBotUsername('given'),
      character: { preset: 'alfred', bodyColor: '#FFAA00' },
    });

    expect(res.status).toBe(201);
    expect(await storedCharacter(res.body.account?.accountId ?? '')).toEqual(GIVEN);
  });

  test('refuses a malformed character, and creates nothing', async () => {
    actingUserId = await seedPersonalAccount();
    const username = uniqueBotUsername('bad');

    const res = await send('POST', '/accounts', {
      kind: 'bot',
      username,
      character: { preset: 'alfred', selections: { color: 'blue' } },
    });

    expect(res.status).toBe(400);
    const rows = await getDb()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, username));
    expect(rows).toHaveLength(0);
  });

  test('refuses a character on any other kind, and a project gets none', async () => {
    actingUserId = await seedPersonalAccount();

    const refused = await send('POST', '/accounts', {
      kind: 'project',
      username: uniqueUsername('proj'),
      character: GIVEN,
    });
    expect(refused.status).toBe(400);

    // Paired: the same request without the character is a normal project, and
    // it carries no character (neither stored nor on the wire).
    const created = await send('POST', '/accounts', {
      kind: 'project',
      username: uniqueUsername('proj'),
    });
    expect(created.status).toBe(201);
    expect(await storedCharacter(created.body.account?.accountId ?? '')).toBeNull();
    expect(created.body.account?.account).not.toHaveProperty('character');
  });
});

describe('PATCH /accounts/:id — the character', () => {
  test('the owner replaces the whole character', async () => {
    const owner = await seedPersonalAccount();
    const bot = await seedChild(owner, 'bot', avatarCharacterFor('seed'));
    actingUserId = owner;

    const res = await send('PATCH', `/accounts/${bot}`, { character: EDITED });

    expect(res.status).toBe(200);
    expect(res.body.account?.account?.character).toEqual(EDITED);
    expect(await storedCharacter(bot)).toEqual(EDITED);
  });

  test('an admin (account:update) may; a viewer (act_as, no account:update) may not', async () => {
    const owner = await seedPersonalAccount();
    const bot = await seedChild(owner, 'bot', GIVEN);
    const admin = await seedPersonalAccount();
    const viewer = await seedPersonalAccount();
    await addMember(bot, admin, 'admin');
    await addMember(bot, viewer, 'viewer');

    actingUserId = viewer;
    const denied = await send('PATCH', `/accounts/${bot}`, { character: EDITED });
    expect(denied.status).toBe(403);
    expect(await storedCharacter(bot)).toEqual(GIVEN);

    actingUserId = admin;
    const allowed = await send('PATCH', `/accounts/${bot}`, { character: EDITED });
    expect(allowed.status).toBe(200);
    expect(await storedCharacter(bot)).toEqual(EDITED);
  });

  test('a stranger with no membership is refused', async () => {
    const owner = await seedPersonalAccount();
    const bot = await seedChild(owner, 'bot', GIVEN);
    actingUserId = await seedPersonalAccount();

    const res = await send('PATCH', `/accounts/${bot}`, { character: EDITED });

    expect([403, 404]).toContain(res.status);
    expect(await storedCharacter(bot)).toEqual(GIVEN);
  });

  test('refuses a malformed character and null (a bot always has one)', async () => {
    const owner = await seedPersonalAccount();
    const bot = await seedChild(owner, 'bot', GIVEN);
    actingUserId = owner;

    const malformed = await send('PATCH', `/accounts/${bot}`, { character: { shape: 'heart' } });
    expect(malformed.status).toBe(400);
    const cleared = await send('PATCH', `/accounts/${bot}`, { character: null });
    expect(cleared.status).toBe(400);
    expect(await storedCharacter(bot)).toEqual(GIVEN);
  });

  test('refuses a character on a non-bot account', async () => {
    const owner = await seedPersonalAccount();
    const project = await seedChild(owner, 'project', null);
    actingUserId = owner;

    const res = await send('PATCH', `/accounts/${project}`, { character: EDITED });

    expect(res.status).toBe(400);
    expect(await storedCharacter(project)).toBeNull();
  });
});

describe('users_character_kind_check', () => {
  test('the database itself refuses a character on a non-bot row', async () => {
    const owner = await seedPersonalAccount();
    await expect(seedChild(owner, 'project', GIVEN)).rejects.toThrow();
  });
});
