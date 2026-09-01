/**
 * `POST /privacy/blocked/:targetId` and `POST /privacy/restricted/:targetId`
 * must REFUSE a target the caller operates — not merely hide the button.
 *
 * The real router over HTTP, against a real Postgres, with a real
 * `accountService`. Only the auth middleware is mocked, because the caller's
 * identity is the one input that does not come from a row. Everything the guard
 * reads — the target's `kind`, the caller's `account_members` row and its
 * status — is stored, so a test cannot pass by agreeing with a fake.
 *
 * ## The two fixtures without which this suite proves nothing
 *
 * "Refuses operators" and "refuses everybody" are indistinguishable unless the
 * suite contains callers who must still SUCCEED, so two are here on purpose:
 *
 *  - a STRANGER blocking an ordinary personal account — the baseline, and the
 *    thing that must not regress;
 *  - a `billing` member of an organization blocking that organization. They are
 *    a member, and they may NOT act as it (`account:act_as` is owner/admin/editor
 *    only), so they keep every affordance a stranger has over it, this one
 *    included. A suite whose only non-owner fixture is a full member cannot tell
 *    the implemented guard from `if (isMember) refuse`.
 *
 * The refusals then come in the two shapes the rule actually distinguishes: an
 * active member of a CHANNEL (membership is the whole right there, since a
 * channel can never be acted as), and a member of an ORGANIZATION who holds
 * `account:act_as` (bare membership is not enough there).
 *
 * Verified by mutation: see `docs` in `accountService.operatesAccount`. Flipping
 * the final line to `true` reds the billing-member and stranger-adjacent cases;
 * flipping it to `false` reds the channel and act-as cases; deleting the
 * `kind !== 'channel'` term reds the channel case alone; removing the route
 * guard reds all four refusals.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { and, eq } from 'drizzle-orm';

/**
 * Whose request it is. Mutated per test rather than re-mounting the app: the
 * router binds `authMiddleware` at import time.
 */
let callerId = '';

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: { id: string } }, _res: unknown, next: () => void) => {
    req.user = { id: callerId };
    next();
  },
}));

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import privacyRouter from '../privacy';
import { errorHandler } from '../../middleware/errorHandler';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { accountMembers } from '../../db/schema/accountMembers';
import { blocks } from '../../db/schema/blocks';
import { restrictions } from '../../db/schema/restrictions';
import { users } from '../../db/schema/users';
import { accountService } from '../../services/account.service';
import type { AccountRole } from '../../utils/accountRoles';
import { permissionsForAccountRole } from '../../utils/accountRoles';

// ===========================================================================
// Harness
// ===========================================================================

let server: http.Server;

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/privacy', privacyRouter);
  app.use(errorHandler);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  await closePostgres();
});

interface JsonResponse {
  status: number;
  body: { message?: string; error?: string };
}

function post(path: string): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'POST',
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: { 'content-type': 'application/json', 'content-length': 2 },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : {} });
          } catch (error) {
            reject(
              new Error(
                `Non-JSON response (${res.statusCode}): ${raw} — ${(error as Error).message}`
              )
            );
          }
        });
      }
    );
    req.on('error', reject);
    req.end('{}');
  });
}

// ===========================================================================
// Fixtures — every one a real row
// ===========================================================================

let seedCounter = 0;

async function seedAccount(
  kind: 'personal' | 'organization' | 'project' | 'bot' | 'channel'
): Promise<string> {
  seedCounter += 1;
  const [row] = await getDb()
    .insert(users)
    .values({
      color: 'teal',
      kind,
      username: `blockop${seedCounter}z${Date.now().toString(36)}`,
      accountStatus: 'active',
    })
    .returning({ id: users.id });
  return row.id;
}

async function seedMembership(options: {
  accountId: string;
  memberUserId: string;
  role: AccountRole;
  status?: 'active' | 'invited' | 'removed';
  inherit?: boolean;
}): Promise<void> {
  await getDb()
    .insert(accountMembers)
    .values({
      accountId: options.accountId,
      memberUserId: options.memberUserId,
      role: options.role,
      status: options.status ?? 'active',
      inherit: options.inherit ?? true,
      joinedAt: new Date(),
    });
}

async function blockRowCount(userId: string, blockedId: string): Promise<number> {
  const rows = await getDb()
    .select({ id: blocks.id })
    .from(blocks)
    .where(and(eq(blocks.userId, userId), eq(blocks.blockedId, blockedId)));
  return rows.length;
}

async function restrictRowCount(userId: string, restrictedId: string): Promise<number> {
  const rows = await getDb()
    .select({ id: restrictions.id })
    .from(restrictions)
    .where(and(eq(restrictions.userId, userId), eq(restrictions.restrictedId, restrictedId)));
  return rows.length;
}

// ===========================================================================
// The role→permission map this suite depends on
//
// The fixtures below are only meaningful if `billing` really lacks
// `account:act_as` and `editor` really holds it. Asserting it here means a
// future grant change that invalidates the fixtures fails LOUDLY, instead of
// silently turning the discriminating test into a second copy of the refusal
// test.
// ===========================================================================

describe('the fixtures rest on the real role map', () => {
  it('billing does NOT carry account:act_as, editor does', () => {
    expect(permissionsForAccountRole('billing')).not.toContain('account:act_as');
    expect(permissionsForAccountRole('editor')).toContain('account:act_as');
  });
});

// ===========================================================================
// Callers who must still succeed
// ===========================================================================

describe('block/restrict still work for callers who do not operate the target', () => {
  it('a stranger blocks an ordinary personal account', async () => {
    const caller = await seedAccount('personal');
    const target = await seedAccount('personal');
    callerId = caller;

    const response = await post(`/privacy/blocked/${target}`);

    expect(response.status).toBe(200);
    expect(response.body.message).toBe('User blocked successfully');
    expect(await blockRowCount(caller, target)).toBe(1);
  });

  it('a stranger restricts an ordinary personal account', async () => {
    const caller = await seedAccount('personal');
    const target = await seedAccount('personal');
    callerId = caller;

    const response = await post(`/privacy/restricted/${target}`);

    expect(response.status).toBe(200);
    expect(await restrictRowCount(caller, target)).toBe(1);
  });

  it("a BILLING member of an organization may still block it — they are a member who may not act as it", async () => {
    const caller = await seedAccount('personal');
    const org = await seedAccount('organization');
    await seedMembership({ accountId: org, memberUserId: caller, role: 'billing' });
    callerId = caller;

    expect(await accountService.operatesAccount(caller, org)).toBe(false);

    const response = await post(`/privacy/blocked/${org}`);

    expect(response.status).toBe(200);
    expect(await blockRowCount(caller, org)).toBe(1);
  });

  it('a VIEWER member of an organization may still block it', async () => {
    const caller = await seedAccount('personal');
    const org = await seedAccount('organization');
    await seedMembership({ accountId: org, memberUserId: caller, role: 'viewer' });
    callerId = caller;

    const response = await post(`/privacy/blocked/${org}`);

    expect(response.status).toBe(200);
    expect(await blockRowCount(caller, org)).toBe(1);
  });

  it('an INVITED (not yet active) channel member may still block the channel', async () => {
    const caller = await seedAccount('personal');
    const channel = await seedAccount('channel');
    await seedMembership({
      accountId: channel,
      memberUserId: caller,
      role: 'editor',
      status: 'invited',
    });
    callerId = caller;

    expect(await accountService.operatesAccount(caller, channel)).toBe(false);

    const response = await post(`/privacy/blocked/${channel}`);

    expect(response.status).toBe(200);
    expect(await blockRowCount(caller, channel)).toBe(1);
  });

  it('a REMOVED channel member may still block the channel', async () => {
    const caller = await seedAccount('personal');
    const channel = await seedAccount('channel');
    await seedMembership({
      accountId: channel,
      memberUserId: caller,
      role: 'owner',
      status: 'removed',
    });
    callerId = caller;

    const response = await post(`/privacy/blocked/${channel}`);

    expect(response.status).toBe(200);
    expect(await blockRowCount(caller, channel)).toBe(1);
  });
});

// ===========================================================================
// Callers who must be refused
// ===========================================================================

describe('block/restrict refuse an account the caller operates', () => {
  it('an ACTIVE channel member cannot block the channel, and nothing is written', async () => {
    const caller = await seedAccount('personal');
    const channel = await seedAccount('channel');
    // `viewer` deliberately: the WEAKEST role there is. A channel can never be
    // acted as, so membership is the whole right over it and the permission
    // gate must not be applied to this family.
    await seedMembership({ accountId: channel, memberUserId: caller, role: 'viewer' });
    callerId = caller;

    expect(await accountService.operatesAccount(caller, channel)).toBe(true);

    const response = await post(`/privacy/blocked/${channel}`);

    expect(response.status).toBe(400);
    expect(response.body.message).toBe('You cannot block an account you operate');
    expect(await blockRowCount(caller, channel)).toBe(0);
  });

  it('an ACTIVE channel member cannot restrict the channel either', async () => {
    const caller = await seedAccount('personal');
    const channel = await seedAccount('channel');
    await seedMembership({ accountId: channel, memberUserId: caller, role: 'viewer' });
    callerId = caller;

    const response = await post(`/privacy/restricted/${channel}`);

    expect(response.status).toBe(400);
    expect(response.body.message).toBe('You cannot restrict an account you operate');
    expect(await restrictRowCount(caller, channel)).toBe(0);
  });

  it('an organization member holding account:act_as cannot block it', async () => {
    const caller = await seedAccount('personal');
    const org = await seedAccount('organization');
    await seedMembership({ accountId: org, memberUserId: caller, role: 'editor' });
    callerId = caller;

    expect(await accountService.operatesAccount(caller, org)).toBe(true);

    const response = await post(`/privacy/blocked/${org}`);

    expect(response.status).toBe(400);
    expect(response.body.message).toBe('You cannot block an account you operate');
    expect(await blockRowCount(caller, org)).toBe(0);
  });

  it('a bot account the caller owns cannot be blocked', async () => {
    const caller = await seedAccount('personal');
    const bot = await seedAccount('bot');
    await seedMembership({ accountId: bot, memberUserId: caller, role: 'owner' });
    callerId = caller;

    const response = await post(`/privacy/blocked/${bot}`);

    expect(response.status).toBe(400);
    expect(await blockRowCount(caller, bot)).toBe(0);
  });

  it('an INHERITED membership counts — a channel under an org the caller edits', async () => {
    const caller = await seedAccount('personal');
    const org = await seedAccount('organization');
    const channel = await seedAccount('channel');
    await accountService.moveAccount(channel, org);
    await seedMembership({ accountId: org, memberUserId: caller, role: 'editor', inherit: true });
    callerId = caller;

    expect(await accountService.operatesAccount(caller, channel)).toBe(true);

    const response = await post(`/privacy/blocked/${channel}`);

    expect(response.status).toBe(400);
    expect(await blockRowCount(caller, channel)).toBe(0);
  });

  it('a NON-INHERITING ancestor membership does not reach the child', async () => {
    const caller = await seedAccount('personal');
    const org = await seedAccount('organization');
    const channel = await seedAccount('channel');
    await accountService.moveAccount(channel, org);
    await seedMembership({ accountId: org, memberUserId: caller, role: 'editor', inherit: false });
    callerId = caller;

    expect(await accountService.operatesAccount(caller, channel)).toBe(false);

    const response = await post(`/privacy/blocked/${channel}`);

    expect(response.status).toBe(200);
    expect(await blockRowCount(caller, channel)).toBe(1);
  });

  it('the self-refusal keeps its own message, and never reaches the operator check', async () => {
    const caller = await seedAccount('personal');
    callerId = caller;

    const response = await post(`/privacy/blocked/${caller}`);

    expect(response.status).toBe(400);
    expect(response.body.message).toBe('Invalid block request');
    expect(await blockRowCount(caller, caller)).toBe(0);
  });
});

// ===========================================================================
// The predicate on its own — the cases the route cannot reach
// ===========================================================================

describe('accountService.operatesAccount', () => {
  it('is true for the caller themselves', async () => {
    const caller = await seedAccount('personal');
    expect(await accountService.operatesAccount(caller, caller)).toBe(true);
  });

  it('is false for a personal account the caller happens to be a member of', async () => {
    // A membership row on a personal account is not a shape any route writes,
    // but the column accepts it. The kind gate — not the absence of a row — is
    // what must refuse it, so the row is here deliberately.
    const caller = await seedAccount('personal');
    const other = await seedAccount('personal');
    await seedMembership({ accountId: other, memberUserId: caller, role: 'owner' });
    expect(await accountService.operatesAccount(caller, other)).toBe(false);
  });

  it('is false for an account id that does not exist', async () => {
    const caller = await seedAccount('personal');
    expect(
      await accountService.operatesAccount(caller, '00000000-0000-7000-8000-000000000000')
    ).toBe(false);
  });

  it('is false for an ARCHIVED account the caller would otherwise operate', async () => {
    // The unconfirmable direction, stated: `resolveEffectiveAccess` reports no
    // access over an archived account, and this predicate defers to it rather
    // than keeping a second opinion. The protective action goes ahead.
    const caller = await seedAccount('personal');
    const channel = await seedAccount('channel');
    await seedMembership({ accountId: channel, memberUserId: caller, role: 'owner' });
    await getDb().update(users).set({ accountStatus: 'archived' }).where(eq(users.id, channel));

    expect(await accountService.operatesAccount(caller, channel)).toBe(false);
  });

  it('is false for empty ids', async () => {
    expect(await accountService.operatesAccount('', '')).toBe(false);
    const caller = await seedAccount('personal');
    expect(await accountService.operatesAccount(caller, '')).toBe(false);
    expect(await accountService.operatesAccount('', caller)).toBe(false);
  });

  it('PROPAGATES a database fault rather than answering "not an operator"', async () => {
    // The decided failure direction has one deliberate exclusion. Everything the
    // predicate can positively read as "not confirmed" answers false and lets
    // the protective action through; a database fault does NOT, because the
    // write this guards runs on the same database and is about to fail anyway.
    // Swallowing it would turn an outage into a silent allow.
    const caller = await seedAccount('personal');
    const channel = await seedAccount('channel');
    await seedMembership({ accountId: channel, memberUserId: caller, role: 'owner' });

    const failure = new Error('connection terminated unexpectedly');
    const spy = jest
      .spyOn(accountService, 'resolveEffectiveAccess')
      .mockRejectedValueOnce(failure);
    try {
      await expect(accountService.operatesAccount(caller, channel)).rejects.toThrow(failure);
    } finally {
      spy.mockRestore();
    }

    // And with the fault gone, the same call answers true — so the assertion
    // above measured the throw, not a fixture that could never have succeeded.
    expect(await accountService.operatesAccount(caller, channel)).toBe(true);
  });
});
