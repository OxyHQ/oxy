/**
 * `users.color` on the ACCOUNT GRAPH — `POST /accounts` and `PATCH /accounts/:id`.
 *
 * A managed account's color is the only visual signal some consumers give it, so
 * it has to be settable at BIRTH (a bot that is discoverable without a color and
 * then acquires one is a face that changes by itself) and editable afterwards by
 * whoever administers the account.
 *
 * The real router over real Postgres with the real `account.service`: the guards
 * are spread across `loadAccountContext` → `requireAccountPermission` → the
 * route body → the service, so mocking the service would leave most of the thing
 * under test unexecuted. Only auth, the rate limiter, the logger and the
 * session/device collaborators (which these routes never touch, but the router
 * imports) are stubbed.
 *
 * ## Every refusal here has a matching permitted case
 *
 * A suite that only sends refused colors cannot tell a route that enforces the
 * policy from one that refuses every write. So each rejection below is paired
 * with a request that differs ONLY in the value or in who is asking.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';

let actingUserId = '';

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (
    req: { user?: { _id: string; id: string } },
    _res: unknown,
    next: () => void
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
import { USER_COLOR_PRESETS, users } from '../../db/schema/users';
import type { AccountRole } from '../../utils/accountRoles';

/**
 * A color the column accepts and the preset catalogue does NOT — the shape of a
 * value stored before the named presets existed (`users_color_check` still
 * admits a legacy hex). Reading one back must work; adopting one must not.
 */
const STORED_LEGACY_COLOR = '#a1b2c3';

interface JsonResponse {
  status: number;
  body: {
    message?: string;
    account?: { account?: { color?: string }; accountId?: string };
  };
}

let server: http.Server;

function uniqueUsername(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString('hex')}`;
}

function send(
  method: 'POST' | 'PATCH' | 'GET',
  path: string,
  payload?: Record<string, unknown>
): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  const body = payload === undefined ? '' : JSON.stringify(payload);
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
      }
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

/** A bot account owned by `ownerUserId`, optionally born with a stored color. */
async function seedBotAccount(
  ownerUserId: string,
  color = 'teal'
): Promise<string> {
  const [bot] = await getDb()
    .insert(users)
    .values({
      color,
      username: uniqueUsername('bot'),
      kind: 'bot',
      parentAccountId: ownerUserId,
      rootAccountId: ownerUserId,
    })
    .returning({ id: users.id });
  await addMember(bot.id, ownerUserId, 'owner');
  return bot.id;
}

async function addMember(
  accountId: string,
  memberUserId: string,
  role: AccountRole
): Promise<void> {
  await getDb().insert(accountMembers).values({
    accountId,
    memberUserId,
    role,
    inherit: true,
    status: 'active',
  });
}

/**
 * A bot already wearing the reserved preset, as an account that once earned it
 * would be. Seeded directly: every route that could write it is gated, which is
 * the point — the fixture has to be reachable without the gate, or the case
 * below would only be testing the gate again.
 */
async function withReservedColourHeld(
  assertion: (botAccountId: string) => Promise<void>
): Promise<void> {
  const operator = await seedPersonalAccount();
  const bot = await seedBotAccount(operator, 'oxy');
  actingUserId = operator;
  await assertion(bot);
}

async function storedColor(accountId: string): Promise<string> {
  const [row] = await getDb()
    .select({ color: users.color })
    .from(users)
    .where(eq(users.id, accountId));
  return row.color;
}

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

describe('POST /accounts — an account born with a color', () => {
  test('persists the color and returns it on the created account', async () => {
    const operator = await seedPersonalAccount();
    actingUserId = operator;
    const username = uniqueUsername('agent');

    const res = await send('POST', '/accounts', {
      kind: 'bot',
      username,
      name: { displayName: 'Agent' },
      color: 'purple',
    });

    expect(res.status).toBe(201);
    // The DTO carries it, so a client never has to re-read to paint the account.
    expect(res.body.account?.account?.color).toBe('purple');
    expect(await storedColor(res.body.account?.accountId ?? '')).toBe('purple');
  });

  test('still applies the platform default when the caller says nothing', async () => {
    // Non-vacuity for the case above: if create wrote `null`/`undefined` over the
    // column default, that case would still pass while every colorless account
    // lost its color. `NOT NULL` would surface it as a 500, not as this.
    const operator = await seedPersonalAccount();
    actingUserId = operator;

    const res = await send('POST', '/accounts', {
      kind: 'bot',
      username: uniqueUsername('agent'),
    });

    expect(res.status).toBe(201);
    expect(USER_COLOR_PRESETS).toContain(
      await storedColor(res.body.account?.accountId ?? '')
    );
  });

  test('refuses a color outside the preset catalogue, and creates nothing', async () => {
    const operator = await seedPersonalAccount();
    actingUserId = operator;
    const username = uniqueUsername('agent');

    const res = await send('POST', '/accounts', {
      kind: 'bot',
      username,
      color: 'not-a-preset',
    });

    expect(res.status).toBe(400);
    // The whole request fails, not just the field: a half-created account with
    // the caller's chosen handle and somebody else's color is worse than a 400.
    const rows = await getDb()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, username));
    expect(rows).toHaveLength(0);
  });

  test('refuses a reserved color for an account that has no claim to it', async () => {
    const operator = await seedPersonalAccount();
    actingUserId = operator;

    const reserved = await send('POST', '/accounts', {
      kind: 'bot',
      username: uniqueUsername('agent'),
      color: 'oxy',
    });
    expect(reserved.status).toBe(400);

    // The positive control: the identical request with a free preset succeeds,
    // so the refusal above is about the VALUE and not about the field existing.
    const free = await send('POST', '/accounts', {
      kind: 'bot',
      username: uniqueUsername('agent'),
      color: 'mint',
    });
    expect(free.status).toBe(201);
    expect(free.body.account?.account?.color).toBe('mint');
  });
});

describe('PATCH /accounts/:id — changing a managed account colour', () => {
  test('an owner may recolour the account they administer', async () => {
    const operator = await seedPersonalAccount();
    const bot = await seedBotAccount(operator);
    actingUserId = operator;

    const res = await send('PATCH', `/accounts/${bot}`, { color: 'sky' });

    expect(res.status).toBe(200);
    expect(res.body.account?.account?.color).toBe('sky');
    expect(await storedColor(bot)).toBe('sky');
  });

  test('a stranger cannot recolour an account they do not administer', async () => {
    const owner = await seedPersonalAccount();
    const bot = await seedBotAccount(owner);
    const stranger = await seedPersonalAccount();
    actingUserId = stranger;

    const res = await send('PATCH', `/accounts/${bot}`, { color: 'sky' });

    expect(res.status).toBe(403);
    expect(await storedColor(bot)).toBe('teal');
  });

  test('a member without `account:update` cannot recolour it either', async () => {
    // The sharper half of the case above: a viewer HOLDS `account:read`, so they
    // are not refused for lacking access to the account — only for lacking the
    // permission that renaming it needs. Colour rides that same permission; it
    // does not get one of its own.
    const owner = await seedPersonalAccount();
    const bot = await seedBotAccount(owner);
    const viewer = await seedPersonalAccount();
    await addMember(bot, viewer, 'viewer');
    actingUserId = viewer;

    const refused = await send('PATCH', `/accounts/${bot}`, { color: 'sky' });
    expect(refused.status).toBe(403);
    expect(await storedColor(bot)).toBe('teal');

    // The viewer can READ the account — so the 403 above is the permission
    // check, not an unreachable route or a missing account.
    const read = await send('GET', `/accounts/${bot}`);
    expect(read.status).toBe(200);
  });

  test('refuses a reserved colour on an account with no claim to it', async () => {
    const operator = await seedPersonalAccount();
    const bot = await seedBotAccount(operator);
    actingUserId = operator;

    const reserved = await send('PATCH', `/accounts/${bot}`, { color: 'oxy' });
    expect(reserved.status).toBe(400);
    expect(await storedColor(bot)).toBe('teal');

    const free = await send('PATCH', `/accounts/${bot}`, { color: 'mint' });
    expect(free.status).toBe(200);
    expect(await storedColor(bot)).toBe('mint');
  });
});

describe('a colour the catalogue no longer contains', () => {
  test('reads back unchanged instead of erroring', async () => {
    const operator = await seedPersonalAccount();
    const bot = await seedBotAccount(operator, STORED_LEGACY_COLOR);
    actingUserId = operator;
    // Non-vacuity: this value is refused on the WRITE path below, so the read
    // succeeding is tolerance rather than the check being absent everywhere.
    expect(USER_COLOR_PRESETS).not.toContain(STORED_LEGACY_COLOR);

    const res = await send('GET', `/accounts/${bot}`);

    expect(res.status).toBe(200);
    expect(res.body.account?.account?.color).toBe(STORED_LEGACY_COLOR);
  });

  test('may be sent back unchanged, but not newly adopted', async () => {
    const operator = await seedPersonalAccount();
    const bot = await seedBotAccount(operator, STORED_LEGACY_COLOR);
    actingUserId = operator;

    // A client that PATCHes back the object it was served must not be 400ed by
    // a field it did not change — that would take the field it DID change down
    // with it.
    const roundTrip = await send('PATCH', `/accounts/${bot}`, {
      color: STORED_LEGACY_COLOR,
      bio: 'unchanged colour, changed bio',
    });
    expect(roundTrip.status).toBe(200);
    expect(await storedColor(bot)).toBe(STORED_LEGACY_COLOR);

    const adopt = await send('PATCH', `/accounts/${bot}`, { color: '#ffffff' });
    expect(adopt.status).toBe(400);
    expect(await storedColor(bot)).toBe(STORED_LEGACY_COLOR);
  });

  test('the same tolerance covers a RESERVED colour the account already holds', () =>
    withReservedColourHeld(async (bot) => {
      // An entitlement can lapse. When it does, the account keeps the colour it
      // was wearing — repainting somebody's profile is not what a subscription
      // ending means — so a PATCH that restates it must not fail, while adopting
      // it fresh still does (the case above).
      const res = await send('PATCH', `/accounts/${bot}`, {
        color: 'oxy',
        bio: 'unchanged colour, changed bio',
      });

      expect(res.status).toBe(200);
      expect(await storedColor(bot)).toBe('oxy');
    }));
});
