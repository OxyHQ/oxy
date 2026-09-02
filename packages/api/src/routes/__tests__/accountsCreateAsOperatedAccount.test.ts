/**
 * Creating a child while OPERATING a managed account.
 *
 * ## The bug
 *
 * Sign in as a person, switch into an organization you own, ask to create an
 * agent, and the API answered `You do not have access to the parent account`.
 * The route read ONE `userId` for three different questions:
 *
 *   - where does the child hang, when the caller names no parent?
 *   - who is authorized to create it?
 *   - who owns the result?
 *
 * On a personal session that is right by accident — the subject and the operator
 * are the same account, so nothing disagrees, and the ambiguity is invisible.
 * Switch into an organization and they diverge: the parent defaulted to the
 * organization (correct), and then authorization asked whether the ORGANIZATION
 * had access to ITSELF. An organization is not a member of itself, and implicit
 * self-ownership is granted only to a `personal` account, so the answer was
 * `null` and the owner of the organization was refused.
 *
 * ## What decides B rather than A
 *
 * Two cases that differ ONLY in the operator's role over the organization pin
 * the model — authority is the operator's role over the parent, not the seat:
 *
 *   - `owner`  → 201, and the child hangs off the ORGANIZATION.
 *   - `editor` → 403, because editor has no `children:create`.
 *
 * Either alone is satisfiable by a blanket rule; together they are not.
 *
 * That pair does NOT, however, catch the tempting wrong fix — letting any
 * account be its own implicit owner. This was measured rather than assumed, and
 * it is worth stating because the opposite is the intuitive guess: once
 * authorization asks the OPERATOR, `accountId === userId` is false on this route
 * and the self-access branch never executes, so model A passes the pair
 * untouched. The two changes are independent.
 *
 * Model A becomes reachable on the DEGRADED path — a session whose
 * `operatedByUserId` cannot be read, where `resolveOperatorId` falls back to the
 * authenticated account and the organization does end up asking about itself.
 * `the degraded-session path` below is the test that pins the restriction, and
 * it is the one that turns red if `&& account.kind === 'personal'` is deleted.
 *
 * The real router, the real `account.service`, real Postgres. Only auth, the
 * rate limiter, the logger and the session lookup are stubbed — and the session
 * stub is the point of the fixture, since `operatedByUserId` lives on the
 * server-side session record and never on the bearer.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';

/** The account the session AUTHENTICATES as — the organization, once switched. */
let subjectId = '';
/** The human the session records as operating it, or null for a plain session. */
let operatedByUserId: string | null = null;

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (
    req: { user?: { _id: string; id: string } },
    _res: unknown,
    next: () => void
  ) => {
    req.user = { _id: subjectId, id: subjectId };
    next();
  },
  serviceAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../middleware/requireStaff', () => ({ isStaffUser: () => false }));

// `resolveOperatorId` decodes a sessionId off the bearer and reads the session
// record for `operatedByUserId`. Both halves are stubbed so a test can say "this
// request is operated by X" without minting a real JWT.
jest.mock('../../middleware/authUtils', () => ({
  extractTokenFromRequest: () => 'stub-token',
  decodeToken: () => ({ sessionId: 'stub-session' }),
}));

jest.mock('../../services/session.service', () => ({
  __esModule: true,
  default: {
    createSession: jest.fn(),
    getSession: jest.fn(async () => ({ operatedByUserId })),
  },
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

interface CreatedAccount {
  accountId?: string;
  parentAccountId?: string | null;
  kind?: string;
}

interface JsonResponse {
  status: number;
  body: { message?: string; account?: CreatedAccount };
}

let server: http.Server;

function uniqueUsername(prefix: string): string {
  return `${prefix}${randomBytes(5).toString('hex')}`;
}

/**
 * The same, carrying the label a `bot` account's handle must end in
 * (`botUsernameSchema`, `@oxyhq/contracts`). The question below is who the
 * PARENT and the owner member are, which is asked of a bot throughout — so the
 * handles have to satisfy the bot policy or every 201 becomes a 400.
 */
function uniqueBotUsername(prefix: string): string {
  return `${uniqueUsername(prefix)}bot`;
}

async function seedAccount(kind: 'personal' | 'organization'): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ color: 'teal', username: uniqueUsername(kind), kind })
    .returning({ id: users.id });
  return row.id;
}

async function seedMember(accountId: string, memberUserId: string, role: AccountRole): Promise<void> {
  await getDb()
    .insert(accountMembers)
    .values({ accountId, memberUserId, role, inherit: true, status: 'active' });
}

function createAccount(payload: Record<string, unknown>): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: address.port,
        path: '/accounts',
        method: 'POST',
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
          try {
            resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : {} });
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/accounts', accountsRouter);
  app.use(errorHandler);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePostgres();
});

afterEach(() => {
  operatedByUserId = null;
});

describe('a person operating an organization creates under it', () => {
  it('lets an OWNER of the organization create an agent, and hangs it off the ORGANIZATION', async () => {
    const human = await seedAccount('personal');
    const org = await seedAccount('organization');
    await seedMember(org, human, 'owner');

    // The shape a switched session has: authenticated AS the organization,
    // operated BY the human.
    subjectId = org;
    operatedByUserId = human;

    const res = await createAccount({ kind: 'bot', username: uniqueBotUsername('agent') });

    expect(res.status).toBe(201);
    // The parent is the SUBJECT: switching into an organization is what makes
    // "here" mean the organization.
    expect(res.body.account?.parentAccountId).toBe(org);
  });

  /**
   * The owner member of the new account is the HUMAN, not the organization. A
   * membership row names a person; recording the organization as its own agent's
   * owner would leave an account whose only owner cannot log in.
   */
  it('records the operator as the owner member, not the organization', async () => {
    const human = await seedAccount('personal');
    const org = await seedAccount('organization');
    await seedMember(org, human, 'owner');
    subjectId = org;
    operatedByUserId = human;

    const res = await createAccount({ kind: 'bot', username: uniqueBotUsername('agent') });
    const created = res.body.account?.accountId ?? '';

    const owners = await getDb()
      .select({ memberUserId: accountMembers.memberUserId, role: accountMembers.role })
      .from(accountMembers)
      .where(eq(accountMembers.accountId, created));

    expect(owners).toEqual([{ memberUserId: human, role: 'owner' }]);
  });

  /**
   * `editor` carries `account:act_as`, so an editor CAN reach this state —
   * switched into the organization — but `editor` does not carry
   * `children:create`, so the answer is the role's, not the seat's.
   *
   * Note what this does NOT prove, because it was measured and it surprised me:
   * it does not catch implicit self-ownership. Once authorization asks the
   * operator, `accountId === userId` is false here and the self-branch never
   * runs, so model A passes this untouched. The test that pins the restriction
   * is `the degraded-session path`, below.
   */
  it('REFUSES an editor of the organization, whose role has no children:create', async () => {
    const human = await seedAccount('personal');
    const org = await seedAccount('organization');
    await seedMember(org, human, 'editor');
    subjectId = org;
    operatedByUserId = human;

    const res = await createAccount({ kind: 'bot', username: uniqueBotUsername('agent') });

    expect(res.status).toBe(403);
    expect(res.body.message).toContain('children:create');
  });

  /**
   * And a stranger is refused for the OTHER reason — no access at all — so the
   * two refusals above and below cannot both be one blanket deny.
   */
  it('refuses a human with no membership at all', async () => {
    const stranger = await seedAccount('personal');
    const org = await seedAccount('organization');
    subjectId = org;
    operatedByUserId = stranger;

    const res = await createAccount({ kind: 'bot', username: uniqueBotUsername('agent') });

    expect(res.status).toBe(403);
    expect(res.body.message).toContain('do not have access');
  });
});

describe('the degraded-session path, where implicit self-ownership would escalate', () => {
  /**
   * THE ESCALATION CONTROL — and the reason `effectiveAccessForAccount` grants
   * implicit ownership only to a `personal` account acting as itself.
   *
   * `resolveOperatorId` degrades to the AUTHENTICATED account when the session
   * record cannot be read. That is the safe direction, but only because a
   * managed account is not a member of itself: the degraded request asks
   * "does this organization have access to itself?" and the answer is no.
   *
   * Delete `&& account.kind === 'personal'` — the obvious-looking fix for the
   * original 403 — and that same degraded request is answered `owner`, with the
   * full permission set, for anybody holding a bearer whose subject is the
   * organization. This test is what turns red.
   *
   * Reached here by leaving `operatedByUserId` null on a session whose subject is
   * the organization, which is exactly the state a failed session read produces.
   */
  it('refuses an organization acting as itself with no operator recorded', async () => {
    const org = await seedAccount('organization');
    subjectId = org;
    operatedByUserId = null;

    const res = await createAccount({ kind: 'bot', username: uniqueBotUsername('agent') });

    expect(res.status).toBe(403);
    expect(res.body.message).toContain('do not have access');
  });

  /**
   * The positive half: a PERSONAL account acting as itself is still its own
   * owner. Without this, "refuse self-access" could be implemented by deleting
   * the branch outright, which would break every ordinary signup's first
   * account.
   */
  it('but a personal account acting as itself remains its own owner', async () => {
    const human = await seedAccount('personal');
    subjectId = human;
    operatedByUserId = null;

    const res = await createAccount({ kind: 'project', username: uniqueUsername('proj') });

    expect(res.status).toBe(201);
  });
});

describe('an ordinary personal session is unchanged', () => {
  /**
   * The regression control for everything above. On a personal session the
   * subject and the operator are the same account, so this path must behave
   * exactly as it always did — a change that only fixed the operated case by
   * breaking the common one would still show green on the first describe.
   */
  it('creates under the caller when nobody is being operated', async () => {
    const human = await seedAccount('personal');
    subjectId = human;
    operatedByUserId = null;

    const res = await createAccount({ kind: 'project', username: uniqueUsername('proj') });

    expect(res.status).toBe(201);
    expect(res.body.account?.parentAccountId).toBe(human);
  });

  it('still honours an explicitly named parent', async () => {
    const human = await seedAccount('personal');
    const org = await seedAccount('organization');
    await seedMember(org, human, 'owner');
    subjectId = human;
    operatedByUserId = null;

    const res = await createAccount({
      kind: 'bot',
      username: uniqueBotUsername('agent'),
      parentAccountId: org,
    });

    expect(res.status).toBe(201);
    expect(res.body.account?.parentAccountId).toBe(org);
  });
});
