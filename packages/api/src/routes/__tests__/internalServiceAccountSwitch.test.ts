/**
 * `POST /internal/accounts/:id/service-switch`, over real HTTP against a real
 * Postgres, with the REAL service-token middleware and the REAL account and
 * session services.
 *
 * This endpoint mints a DURABLE SESSION whose subject is a managed account, on
 * the authority of a human's `account:act_as` membership, with no human, no
 * device and no browser anywhere in the request. That is the largest authority
 * anything on `/internal` holds, so the suite is built around what must be
 * REFUSED, and every refusal has its own case with a real row behind it.
 *
 * NOTHING THAT DECIDES IS MOCKED. `serviceAuthMiddleware`, `accountService`,
 * `sessionService` and `jsonwebtoken` are all the real implementations, and the
 * memberships, applications, credentials and accounts are all real rows. Mocking
 * any of the four would delete one of the gates this endpoint is made of and
 * leave the suite green with it removed — which is the exact failure mode these
 * tests exist to rule out. Only the rate limiter, the logger and the socket
 * broadcaster are mocked: two are Redis/socket dependencies and one is noise.
 *
 * THE TWO ASSERTIONS ON A SUCCESSFUL MINT ARE BOTH LOAD-BEARING. `sub` proves
 * the session's subject is the managed account; `act.sub` proves the operating
 * human was recorded. An implementation that forgets `operatedByUserId` passes
 * the first and fails the second — and that omission is precisely what would
 * make the minted session IRREVOCABLE, because the `account:act_as` re-check on
 * validate/refresh keys off the operator being present.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'node:crypto';

/** The middleware verifies the token itself, so the real JWT must be used. */
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));

jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
/**
 * `session.service` imports the socket broadcaster at module load. Nothing this
 * endpoint reaches emits (the migrate-onto-a-central-device path needs an
 * explicit `deviceId`, which a service mint never passes), so this only keeps a
 * live socket server out of the suite.
 */
jest.mock('../../utils/socket', () => ({
  broadcastDeviceState: jest.fn(),
  broadcastSessionAccountsChanged: jest.fn(),
}));

import { eq } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { accountMembers } from '../../db/schema/accountMembers';
import { appGrants } from '../../db/schema/appGrants';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { sessions } from '../../db/schema/sessions';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import {
  revokeServiceActingAs,
  SERVICE_ACTING_AS_SCOPE,
} from '../../services/serviceActingAs.service';
import { SERVICE_ACCOUNT_SWITCH_SCOPE } from '../../utils/applicationScopes';
import { deriveServiceDeviceId } from '../../utils/deviceUtils';
import internalRouter from '../internal';

const ACCESS_TOKEN_SECRET = 'service-account-switch-test-access-secret-32ch';
const REFRESH_TOKEN_SECRET = 'service-account-switch-test-refresh-secret-32c';
/**
 * `deriveServiceDeviceId` FAILS CLOSED without a salt — it throws rather than
 * derive an unsalted id. Production always has one (`validateRequiredEnvVars`);
 * the api-test job does not set one, so the suite supplies its own.
 */
const DEVICE_ID_SALT = 'service-account-switch-test-device-id-salt-48chars';

/** Every account kind the switch target may be, so the refusals can be real. */
type AccountKind = 'personal' | 'organization' | 'project' | 'bot' | 'channel';

interface SwitchResponse {
  status: number;
  body: {
    data?: {
      sessionId?: string;
      deviceId?: string;
      expiresAt?: string;
      accessToken?: string;
      user?: { id?: string; username?: string; avatar?: string };
    };
    error?: string;
    message?: string;
  };
}

interface SeededApp {
  appId: string;
  credentialId: string;
  ownerAccountId: string;
  scopes: string[];
}

let server: http.Server;

async function account(kind: AccountKind, status: 'active' | 'archived' = 'active') {
  const [row] = await getDb()
    .insert(users)
    .values({
      username: `acct-${randomUUID().slice(0, 18)}`,
      kind,
      accountStatus: status,
    })
    .returning({ id: users.id });
  return row.id;
}

/** A human operator. `personal` is the only kind a member row may name. */
function human(): Promise<string> {
  return account('personal');
}

/**
 * A real membership. The ROLE is the dial the authorization cases turn:
 * `admin` carries `account:act_as` in its baseline, `viewer` deliberately does
 * not. Seeding a `viewer` rather than seeding nothing is what makes the
 * unauthorized case measure the PERMISSION — with no row at all it would pass
 * against an implementation that only checked membership.
 */
async function member(
  accountId: string,
  memberUserId: string,
  role: 'admin' | 'viewer'
): Promise<void> {
  await getDb().insert(accountMembers).values({ accountId, memberUserId, role, status: 'active' });
}

/**
 * An application plus one service credential — real rows, so the trust gate and
 * the token's `credentialId` claim both resolve.
 *
 * `scopes` is what the APPLICATION holds; the token below is minted with the
 * same set, which is what the real mint's `intersectScopes` would produce.
 */
async function seedApp(
  options: {
    type?: 'internal' | 'third_party';
    status?: 'active' | 'suspended';
    scopes?: string[];
  } = {}
): Promise<SeededApp> {
  const type = options.type ?? 'internal';
  const status = options.status ?? 'active';
  const scopes = options.scopes ?? ['user:read', SERVICE_ACCOUNT_SWITCH_SCOPE];
  const ownerAccountId = await human();
  const [app] = await getDb()
    .insert(applications)
    .values({ name: `App ${randomUUID()}`, type, status, scopes, ownerAccountId })
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
  return jwt.sign(
    {
      type: 'service',
      appId: app.appId,
      appName: 'Alia',
      credentialId: app.credentialId,
      ownerAccountId: app.ownerAccountId,
      environment: 'production',
      scopes: app.scopes,
    },
    ACCESS_TOKEN_SECRET,
    { expiresIn: 3600 }
  );
}

function serviceSwitch(
  accountId: string,
  token: string | null,
  operatorId: string | null
): Promise<SwitchResponse> {
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'POST',
        host: '127.0.0.1',
        port: address.port,
        path: `/internal/accounts/${encodeURIComponent(accountId)}/service-switch`,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(operatorId ? { 'x-oxy-user-id': operatorId } : {}),
          'content-length': '0',
          connection: 'close',
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: raw.length > 0 ? JSON.parse(raw) : {} })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * Explicit consent is independent from both platform trust and the managed
 * account membership. Keep the insert visible in this suite so no success can
 * accidentally regress to an implicit first-party bypass.
 */
async function grantOffline(app: SeededApp, operatorId: string): Promise<void> {
  await getDb().insert(appGrants).values({
    userId: operatorId,
    applicationId: app.appId,
    scopes: [SERVICE_ACTING_AS_SCOPE],
  });
}

async function grantedServiceSwitch(
  accountId: string,
  app: SeededApp,
  operatorId: string
): Promise<SwitchResponse> {
  await grantOffline(app, operatorId);
  return serviceSwitch(accountId, serviceToken(app), operatorId);
}

/** The v2 access-token claims the mint asserts. Read with the real verifier. */
function claims(accessToken: string): { sub?: string; act?: { sub?: string }; sid?: string } {
  const decoded = jwt.verify(accessToken, ACCESS_TOKEN_SECRET);
  if (typeof decoded === 'string') {
    throw new Error('access token did not decode to a claim set');
  }
  return decoded as { sub?: string; act?: { sub?: string }; sid?: string };
}

/** Every session row the mint could have written for this account. */
function sessionRowsFor(userId: string) {
  return getDb()
    .select({ id: sessions.id, deviceId: sessions.deviceId, operatedByUserId: sessions.operatedByUserId })
    .from(sessions)
    .where(eq(sessions.userId, userId));
}

beforeAll(async () => {
  process.env.ACCESS_TOKEN_SECRET = ACCESS_TOKEN_SECRET;
  process.env.REFRESH_TOKEN_SECRET = REFRESH_TOKEN_SECRET;
  process.env.DEVICE_ID_SALT = DEVICE_ID_SALT;
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/internal', internalRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePostgres();
});

// ---------------------------------------------------------------------------
// The router's own two gates still cover this endpoint
//
// Both are `router.use(...)` on `internal.ts`, so a route registered ABOVE them
// would silently bypass both. That is a one-line mistake with no other symptom,
// which is why the cheap cases are here rather than assumed.
// ---------------------------------------------------------------------------

describe('router gates', () => {
  it('refuses a request with no Authorization header (401)', async () => {
    // DECLARED WEAKNESS: this case SURVIVES moving the route ABOVE both
    // `router.use` gates — the handler's own `if (!serviceApp)` answers 401 too,
    // so it cannot tell the router's gate from the handler's. The two cases
    // below are what discriminate: with the gates bypassed they get 401 where
    // they expect 403. Verified by running that mutation: 19 of 20 go red.
    const bot = await account('bot');
    const operator = await human();
    await member(bot, operator, 'admin');

    const res = await serviceSwitch(bot, null, operator);

    expect(res.status).toBe(401);
    expect(res.body.data).toBeUndefined();
  });

  it('refuses a USER session token (403) — this is not a user-facing surface', async () => {
    const bot = await account('bot');
    const operator = await human();
    await member(bot, operator, 'admin');
    const userJwt = jwt.sign(
      { type: 'access', userId: operator, sessionId: 'session-1' },
      ACCESS_TOKEN_SECRET,
      { expiresIn: 3600 }
    );

    const res = await serviceSwitch(bot, userJwt, operator);

    expect(res.status).toBe(403);
    expect(res.body.data).toBeUndefined();
  });

  it('refuses a THIRD-PARTY caller holding the scope and a valid token (403)', async () => {
    // Holding a service token and being a first-party Oxy service are different
    // sets — the mint has a payments-only carve-out for external merchants.
    const app = await seedApp({ type: 'third_party' });
    const bot = await account('bot');
    const operator = await human();
    await member(bot, operator, 'admin');

    const res = await grantedServiceSwitch(bot, app, operator);

    expect(res.status).toBe(403);
    expect(res.body.data).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The scope — the endpoint's own gate, on top of the router's two
// ---------------------------------------------------------------------------

describe('the service-account-switch scope', () => {
  it('refuses a TRUSTED app whose token does not carry it (403)', async () => {
    // The load-bearing negative of the whole change. Every application that can
    // reach this router is trusted, so trust cannot be what authorizes minting a
    // session as somebody's bot — the scope has to be, or the endpoint is open
    // to every first-party service on the platform.
    const app = await seedApp({ scopes: ['user:read', 'acting-as:offline'] });
    const bot = await account('bot');
    const operator = await human();
    await member(bot, operator, 'admin');

    const res = await grantedServiceSwitch(bot, app, operator);

    expect(res.status).toBe(403);
    expect(res.body.data).toBeUndefined();
  });

  it('is NOT satisfied by acting-as:offline, whose authority is strictly smaller', async () => {
    // `acting-as:offline` authorises per-request ATTRIBUTION. Accepting it here
    // would silently hand every application that already holds it the power to
    // mint durable sessions as other accounts.
    const app = await seedApp({ scopes: ['acting-as:offline'] });
    const bot = await account('bot');
    const operator = await human();
    await member(bot, operator, 'admin');

    expect((await serviceSwitch(bot, serviceToken(app), operator)).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// The operating human
// ---------------------------------------------------------------------------

describe('the operator header', () => {
  it('refuses a request that names no operator (400)', async () => {
    // There is no human in the request, so there is no fallback: without the
    // header there is nobody whose `account:act_as` could authorise the mint,
    // and no actor to record on the session.
    const app = await seedApp();
    const bot = await account('bot');

    const res = await serviceSwitch(bot, serviceToken(app), null);

    expect(res.status).toBe(400);
    expect(res.body.data).toBeUndefined();
  });

  it('refuses an operator with membership but WITHOUT account:act_as (403)', async () => {
    // A `viewer` is a real, active member of the bot. Bare membership must not
    // be enough — `billing`, `developer` and `viewer` are deliberately members
    // who may manage facets of an account and never speak as it.
    const app = await seedApp();
    const bot = await account('bot');
    const operator = await human();
    await member(bot, operator, 'viewer');

    const res = await grantedServiceSwitch(bot, app, operator);

    expect(res.status).toBe(403);
    expect(res.body.data).toBeUndefined();
    expect(await sessionRowsFor(bot)).toHaveLength(0);
  });

  it('refuses an operator with no relationship to the account at all (403)', async () => {
    const app = await seedApp();
    const bot = await account('bot');
    const stranger = await human();

    expect((await grantedServiceSwitch(bot, app, stranger)).status).toBe(403);
  });

  it('refuses a trusted app with no explicit operator grant (403)', async () => {
    const app = await seedApp();
    const bot = await account('bot');
    const operator = await human();
    await member(bot, operator, 'admin');

    const res = await serviceSwitch(bot, serviceToken(app), operator);

    expect(res.status).toBe(403);
    expect(res.body.data).toBeUndefined();
    expect(await sessionRowsFor(bot)).toHaveLength(0);
  });

  it('refuses an operator the app grant was revoked by (403)', async () => {
    // The human explicitly consents and holds `account:act_as`; after revoke,
    // the refusal marker wins even if a stale grant row were recreated.
    const app = await seedApp();
    const bot = await account('bot');
    const operator = await human();
    await member(bot, operator, 'admin');

    const before = await grantedServiceSwitch(bot, app, operator);
    expect(before.status).toBe(200);

    await revokeServiceActingAs(operator, app.appId);

    const after = await serviceSwitch(bot, serviceToken(app), operator);
    expect(after.status).toBe(403);
    expect(after.body.data).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Which accounts may be minted as
//
// Every case seeds a REAL `account:act_as` membership, so the only thing left
// that can refuse is the kind. Without that membership these would pass against
// an implementation with no kind check at all.
// ---------------------------------------------------------------------------

describe('the target account', () => {
  it('refuses a PERSONAL account even to an operator holding act_as (403)', async () => {
    const app = await seedApp();
    const person = await account('personal');
    const operator = await human();
    await member(person, operator, 'admin');

    const res = await grantedServiceSwitch(person, app, operator);

    expect(res.status).toBe(403);
    expect(res.body.data).toBeUndefined();
    expect(await sessionRowsFor(person)).toHaveLength(0);
  });

  it('refuses a CHANNEL account even to an operator holding act_as (403)', async () => {
    // A channel is a content identity nobody occupies. Refusing it here is what
    // makes "a channel can never be logged into" structural: no session whose
    // subject is a channel can exist, so no bearer exists that could add an auth
    // method to one.
    const app = await seedApp();
    const channel = await account('channel');
    const operator = await human();
    await member(channel, operator, 'admin');

    const res = await grantedServiceSwitch(channel, app, operator);

    expect(res.status).toBe(403);
    expect(await sessionRowsFor(channel)).toHaveLength(0);
  });

  it('answers 404 for an account that does not exist', async () => {
    const app = await seedApp();
    const operator = await human();

    const res = await grantedServiceSwitch(randomUUID(), app, operator);

    expect(res.status).toBe(404);
    expect(res.body.data).toBeUndefined();
  });

  it('answers 404 for an ARCHIVED account the operator can act as', async () => {
    const app = await seedApp();
    const bot = await account('bot', 'archived');
    const operator = await human();
    await member(bot, operator, 'admin');

    expect((await grantedServiceSwitch(bot, app, operator)).status).toBe(404);
  });

  /**
   * The lane that must NOT close when the account switcher does.
   *
   * A person can no longer switch into a bot — a bot is something that operates
   * on your behalf, not a seat you occupy — and this endpoint is the mechanism by
   * which that operating happens. The two questions were one predicate until
   * they were split, so this asserts the split kept the delegation half OPEN:
   * without it, narrowing the switcher would silently take every Alia agent
   * offline, and the symptom would be an agent that simply stops answering.
   */
  it('STILL mints for a BOT — the switcher narrowing must not close this lane', async () => {
    const app = await seedApp();
    const bot = await account('bot');
    const operator = await human();
    await member(bot, operator, 'admin');

    const res = await grantedServiceSwitch(bot, app, operator);

    expect(res.status).toBe(200);
    expect(claims(res.body.data?.accessToken ?? '').sub).toBe(bot);
  });

  it('mints for an ORGANIZATION and a PROJECT too, not only a bot', async () => {
    // The eligible set is three kinds. Testing only `bot` would leave an
    // implementation that hardcoded `kind === 'bot'` green.
    const app = await seedApp();
    for (const kind of ['organization', 'project'] as const) {
      const target = await account(kind);
      const operator = await human();
      await member(target, operator, 'admin');

      const res = await grantedServiceSwitch(target, app, operator);

      expect(res.status).toBe(200);
      expect(claims(res.body.data?.accessToken ?? '').sub).toBe(target);
    }
  });
});

// ---------------------------------------------------------------------------
// The mint itself
// ---------------------------------------------------------------------------

describe('a successful mint', () => {
  it('mints a session whose SUBJECT is the account and whose ACTOR is the human', async () => {
    const app = await seedApp();
    const bot = await account('bot');
    const operator = await human();
    await member(bot, operator, 'admin');

    const res = await grantedServiceSwitch(bot, app, operator);

    expect(res.status).toBe(200);
    const accessToken = res.body.data?.accessToken;
    expect(typeof accessToken).toBe('string');

    const payload = claims(accessToken ?? '');
    // BOTH, and the second is the one that is easy to lose. `sub` alone would
    // pass for a session nothing can revoke.
    expect(payload.sub).toBe(bot);
    expect(payload.act?.sub).toBe(operator);
    expect(payload.sid).toBe(res.body.data?.sessionId);

    // The row, not only the token: the `account:act_as` re-check on validate and
    // refresh reads `operated_by_user_id` off the session, not off the claim.
    const rows = await sessionRowsFor(bot);
    expect(rows).toHaveLength(1);
    expect(rows[0].operatedByUserId).toBe(operator);
    expect(rows[0].deviceId).toBe(res.body.data?.deviceId);
  });

  it('mints an UNBOUND bearer — no `azp`, no `scope`, full authority over the account', async () => {
    // Measured, not assumed: the minted token carries
    // `act aud deviceId exp iat iss jti sessionId sid sub type userId ver` and
    // NEITHER `azp` NOR `scope`, and the row stores
    // `application_id=null client_id=null scopes=[]`.
    //
    // That is inherited from the user-facing switch, which passes no
    // `application` binding either, and it is recorded here rather than left
    // implicit because it is the endpoint's widest property: the bearer can do
    // anything the account can do, including deleting it. Narrowing it is NOT a
    // matter of passing `application.scopes` — NOTHING in this repository gates
    // on a session's scopes (`req.oxyToken.scopes` has no consumers), so writing
    // them would produce a claim that authorizes nothing while reading as a
    // limit. A real narrowing needs an enforcement point first.
    //
    // This test goes RED the day that changes, which is the point: it makes the
    // change a line somebody writes deliberately instead of a silent widening or
    // a silent, ineffective narrowing.
    const app = await seedApp();
    const bot = await account('bot');
    const operator = await human();
    await member(bot, operator, 'admin');

    const res = await grantedServiceSwitch(bot, app, operator);
    const payload = claims(res.body.data?.accessToken ?? '') as Record<string, unknown>;

    expect('azp' in payload).toBe(false);
    expect('scope' in payload).toBe(false);
    // Positive control: the decoder is still capable of seeing claims at all.
    expect(payload.sub).toBe(bot);

    const [row] = await getDb()
      .select({
        applicationId: sessions.applicationId,
        clientId: sessions.clientId,
        scopes: sessions.scopes,
      })
      .from(sessions)
      .where(eq(sessions.userId, bot));
    expect(row).toEqual({ applicationId: null, clientId: null, scopes: [] });
  });

  it('returns the account as the session user, never the operator', async () => {
    const app = await seedApp();
    const bot = await account('bot');
    const operator = await human();
    await member(bot, operator, 'admin');

    const res = await grantedServiceSwitch(bot, app, operator);

    expect(res.body.data?.user?.id).toBe(bot);
    expect(res.body.data?.user?.id).not.toBe(operator);
    expect(typeof res.body.data?.expiresAt).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// `stableDeviceKey` — the difference between one device row and unbounded growth
// ---------------------------------------------------------------------------

describe('device attribution', () => {
  it('reuses ONE device and ONE session across repeated mints for the same (app, account)', async () => {
    // A server-to-server mint carries no User-Agent, so without an explicit
    // stable key `extractDeviceInfo` falls all the way through to a RANDOM
    // deviceId — a fresh device and a fresh `sessions` row on every single call,
    // forever. The bug is invisible until the table grows in production, which
    // is why it is asserted here and not left to review.
    const app = await seedApp();
    const bot = await account('bot');
    const operator = await human();
    await member(bot, operator, 'admin');

    await grantOffline(app, operator);
    const first = await serviceSwitch(bot, serviceToken(app), operator);
    const second = await serviceSwitch(bot, serviceToken(app), operator);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.data?.deviceId).toBe(first.body.data?.deviceId);
    expect(second.body.data?.sessionId).toBe(first.body.data?.sessionId);

    const rows = await sessionRowsFor(bot);
    expect(rows).toHaveLength(1);
  });

  it('derives that device from (account, app), so it is stable and per-application', async () => {
    // The positive form of the assertion above: a row count of one is also what
    // a broken second call that never inserted would produce. This says WHICH
    // device the mint chose, and it can only hold if the stable key was used.
    const app = await seedApp();
    const bot = await account('bot');
    const operator = await human();
    await member(bot, operator, 'admin');

    const res = await grantedServiceSwitch(bot, app, operator);

    expect(res.body.data?.deviceId).toBe(
      deriveServiceDeviceId(bot, `service:${app.appId}:${bot}`)
    );
  });

  it('gives two APPLICATIONS acting as one account two different devices', async () => {
    // DECLARED WEAKNESS: this case SURVIVES deleting `stableDeviceKey` from the
    // route — two RANDOM device ids also differ, so on its own it proves the key
    // is per-application only if the key exists at all. It is kept as the
    // companion to the derivation assertion above, which is what actually kills
    // that mutation. Verified by running the mutation: 3 cases go red and this
    // is not one of them.
    const alia = await seedApp();
    const other = await seedApp();
    const bot = await account('bot');
    const operator = await human();
    await member(bot, operator, 'admin');

    const fromAlia = await grantedServiceSwitch(bot, alia, operator);
    const fromOther = await grantedServiceSwitch(bot, other, operator);

    expect(fromAlia.body.data?.deviceId).not.toBe(fromOther.body.data?.deviceId);
    expect(await sessionRowsFor(bot)).toHaveLength(2);
  });

  it('gives two OPERATORS of one account two different sessions on the same device', async () => {
    // One account can legitimately be operated by two people through the same
    // application. They must not share a session row: `operated_by_user_id` is
    // the audit actor and the revocation key, so a shared row would change actor
    // underneath a live session and let removing either person kill the other's
    // access.
    const app = await seedApp();
    const bot = await account('bot');
    const first = await human();
    const second = await human();
    await member(bot, first, 'admin');
    await member(bot, second, 'admin');

    const one = await grantedServiceSwitch(bot, app, first);
    const two = await grantedServiceSwitch(bot, app, second);

    expect(one.body.data?.deviceId).toBe(two.body.data?.deviceId);
    expect(one.body.data?.sessionId).not.toBe(two.body.data?.sessionId);

    const rows = await sessionRowsFor(bot);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.operatedByUserId).sort()).toEqual([first, second].sort());
  });
});
