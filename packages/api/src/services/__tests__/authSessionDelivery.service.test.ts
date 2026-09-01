/**
 * Automatic Commons delivery + delivery-progress bookkeeping, against a REAL
 * Postgres.
 *
 * ## The guarantees this file exists for
 *
 *  1. **Delivery targets ONLY the authenticated identity's own installs.** The
 *     user id is handed in by the caller (the bearer's), never derived from the
 *     request — that is what stops a sign-in prompt being pushed at someone by
 *     typing their username into an unauthenticated browser.
 *  2. **Eligibility is the `identity:approval` capability, and nothing else.**
 *     Not a client id, not a bundle id, not an app name. An install of an
 *     application without the capability, or of a suspended one, is not a
 *     target; neither is an UNSCOPED install (`application_id` NULL).
 *  3. **The push payload is exactly `{ type, approvalUrl }`** — no application
 *     name, no scopes, no origin, and never the secret `sessionToken`.
 *  4. **`openedAt` is written AT MOST ONCE, only while pending and unexpired,
 *     and never touches `status`.**
 *
 * ## Why the previous version could not prove any of them
 *
 * It replaced `models/AuthSession`, `models/Application` and `models/PushToken`
 * with `jest.fn()`s and then asserted the SHAPE of the query object those stubs
 * received (`{ userId: 'user-1', applicationId: { $in: [...] } }`). An assertion
 * about a query object is worth nothing: it holds just as well when the filter
 * selects the wrong rows, and it cannot see a row the filter should have
 * excluded, because no row exists. Here the installs, the applications and the
 * requests are real rows and the assertions are about which of them came back.
 *
 * Only the push TRANSPORT is mocked — `push.service` is an HTTP client for
 * `exp.host` with its own suite, and what matters here is which tokens it is
 * handed and what payload rides with them.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

const mockSendPushToTokens = jest.fn();

jest.mock('../../services/push.service', () => ({
  __esModule: true,
  pushService: { sendPushToTokens: mockSendPushToTokens, sendPushNotification: jest.fn() },
  default: { sendPushToTokens: mockSendPushToTokens, sendPushNotification: jest.fn() },
}));

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { IDENTITY_APPROVAL_PUSH_CHANNEL } from '@oxyhq/contracts';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applications } from '../../db/schema/applications';
import { authSessions } from '../../db/schema/authSessions';
import { pushTokens } from '../../db/schema/pushTokens';
import { users } from '../../db/schema/users';
import { IDENTITY_APPROVAL_CAPABILITY } from '../../utils/applicationCapabilities';
import {
  buildApprovalUrl,
  deliverAuthRequestToIdentityApps,
  markAuthRequestOpened,
  IDENTITY_APPROVAL_PUSH_TYPE,
} from '../authSessionDelivery.service';

const IN_AN_HOUR = () => new Date(Date.now() + 3_600_000);
const AN_HOUR_AGO = () => new Date(Date.now() - 3_600_000);

/** The literal secret every case checks never reaches the push transport. */
const SECRET_MARKER = 'SECRET-session-token-do-not-leak';

let USER_ID: string;
let OTHER_USER_ID: string;
/** An application carrying `identity:approval` — the vault. */
let VAULT_APP_ID: string;
/** An ordinary active application WITHOUT the capability. */
let PLAIN_APP_ID: string;

async function insertUser(): Promise<string> {
  const [row] = await getDb().insert(users).values({}).returning({ id: users.id });
  return row.id;
}

async function insertApplication(
  fields: Partial<typeof applications.$inferInsert> = {}
): Promise<string> {
  const ownerAccountId = fields.ownerAccountId ?? (await insertUser());
  const [row] = await getDb()
    .insert(applications)
    .values({ name: `App ${randomUUID()}`, ...fields, ownerAccountId })
    .returning({ id: applications.id });
  return row.id;
}

async function insertInstall(
  userId: string,
  token: string,
  applicationId: string | null
): Promise<void> {
  await getDb()
    .insert(pushTokens)
    .values({ userId, token, platform: 'ios', applicationId });
}

interface StoredRequest {
  authorizeCode: string;
  sessionToken: string;
}

async function insertRequest(
  overrides: Partial<typeof authSessions.$inferInsert> = {}
): Promise<StoredRequest> {
  const applicationId = overrides.applicationId ?? VAULT_APP_ID;
  const sessionToken = `${SECRET_MARKER}-${randomUUID()}`;
  const authorizeCode = randomUUID().replace(/-/g, '');
  await getDb()
    .insert(authSessions)
    .values({
      sessionToken,
      authorizeCode,
      status: 'pending',
      expiresAt: IN_AN_HOUR(),
      ...overrides,
      applicationId,
    });
  return { authorizeCode, sessionToken };
}

/** The stored row, so a claim about what a write did is read back from Postgres. */
async function storedRequest(authorizeCode: string) {
  const [row] = await getDb()
    .select({
      status: authSessions.status,
      pushSentAt: authSessions.pushSentAt,
      openedAt: authSessions.openedAt,
    })
    .from(authSessions)
    .where(eq(authSessions.authorizeCode, authorizeCode))
    .limit(1);
  return row;
}

/** Every key path in a nested object — used to prove the payload leaks nothing. */
function collectKeyPaths(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return [path, ...collectKeyPaths(child, path)];
  });
}

/** The tokens the push transport was handed, in the order it received them. */
function pushedTokens(): string[] {
  return (mockSendPushToTokens.mock.calls[0]?.[0] as { tokens: string[] } | undefined)?.tokens ?? [];
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(async () => {
  jest.clearAllMocks();
  mockSendPushToTokens.mockResolvedValue({ targeted: 1, accepted: 1 });
  // Fresh rows per case: real unique indexes and real foreign keys mean a
  // leftover install from a previous case would decide the next one.
  USER_ID = await insertUser();
  OTHER_USER_ID = await insertUser();
  VAULT_APP_ID = await insertApplication({ capabilities: [IDENTITY_APPROVAL_CAPABILITY] });
  PLAIN_APP_ID = await insertApplication();
});

describe('deliverAuthRequestToIdentityApps — the target is the AUTHENTICATED identity', () => {
  it("never delivers to another identity's install of the very same vault", async () => {
    // Both people have a Commons install. The service is told about ONE of them
    // and must not touch the other — the whole point of the bearer being the
    // security control rather than a convenience.
    await insertInstall(USER_ID, 'tok-mine', VAULT_APP_ID);
    await insertInstall(OTHER_USER_ID, 'tok-theirs', VAULT_APP_ID);
    const { authorizeCode } = await insertRequest();

    const outcome = await deliverAuthRequestToIdentityApps({
      authorizeCode,
      identityUserId: USER_ID,
    });

    expect(outcome).toMatchObject({ ok: true, delivered: true, targets: 1 });
    expect(pushedTokens()).toEqual(['tok-mine']);
  });

  it('reports zero targets for an identity with no install at all', async () => {
    await insertInstall(OTHER_USER_ID, 'tok-theirs', VAULT_APP_ID);
    const { authorizeCode, sessionToken } = await insertRequest();

    const outcome = await deliverAuthRequestToIdentityApps({
      authorizeCode,
      identityUserId: USER_ID,
    });

    // `targets: 0` is a NORMAL outcome — the client falls back to the QR.
    expect(outcome).toEqual({ ok: true, sessionToken, delivered: false, targets: 0 });
    expect(mockSendPushToTokens).not.toHaveBeenCalled();
  });
});

describe('deliverAuthRequestToIdentityApps — eligibility is the capability, nothing else', () => {
  it('targets an install of a capability-carrying application', async () => {
    await insertInstall(USER_ID, 'tok-vault', VAULT_APP_ID);
    const { authorizeCode } = await insertRequest();

    const outcome = await deliverAuthRequestToIdentityApps({
      authorizeCode,
      identityUserId: USER_ID,
    });

    expect(outcome).toMatchObject({ delivered: true, targets: 1 });
    expect(pushedTokens()).toEqual(['tok-vault']);
  });

  it("ignores the same identity's install of an application WITHOUT the capability", async () => {
    // The registry decides, not the app's identity: an ordinary active
    // application the user also has installed must never be pushed an approval.
    await insertInstall(USER_ID, 'tok-plain', PLAIN_APP_ID);
    const { authorizeCode } = await insertRequest();

    const outcome = await deliverAuthRequestToIdentityApps({
      authorizeCode,
      identityUserId: USER_ID,
    });

    expect(outcome).toMatchObject({ delivered: false, targets: 0 });
    expect(mockSendPushToTokens).not.toHaveBeenCalled();
  });

  it('ignores an install of a SUSPENDED application even when it carries the capability', async () => {
    const suspended = await insertApplication({
      capabilities: [IDENTITY_APPROVAL_CAPABILITY],
      status: 'suspended',
    });
    await insertInstall(USER_ID, 'tok-suspended', suspended);
    const { authorizeCode } = await insertRequest();

    const outcome = await deliverAuthRequestToIdentityApps({
      authorizeCode,
      identityUserId: USER_ID,
    });

    expect(outcome).toMatchObject({ delivered: false, targets: 0 });
  });

  it('ignores an UNSCOPED install — NULL application_id is "no application", never "any"', async () => {
    // The email push registry predates app scoping and registers with no
    // `clientId`. Such a row must be invisible to a capability-scoped decision.
    await insertInstall(USER_ID, 'tok-unscoped', null);
    const { authorizeCode } = await insertRequest();

    const outcome = await deliverAuthRequestToIdentityApps({
      authorizeCode,
      identityUserId: USER_ID,
    });

    expect(outcome).toMatchObject({ delivered: false, targets: 0 });
    expect(mockSendPushToTokens).not.toHaveBeenCalled();
  });

  it('targets only the capable installs when the identity holds a mix', async () => {
    await insertInstall(USER_ID, 'tok-vault', VAULT_APP_ID);
    await insertInstall(USER_ID, 'tok-plain', PLAIN_APP_ID);
    await insertInstall(USER_ID, 'tok-unscoped', null);
    const { authorizeCode } = await insertRequest();

    const outcome = await deliverAuthRequestToIdentityApps({
      authorizeCode,
      identityUserId: USER_ID,
    });

    expect(outcome).toMatchObject({ delivered: true, targets: 1 });
    expect(pushedTokens()).toEqual(['tok-vault']);
  });

  it('sends nothing when NO application carries the capability at all', async () => {
    await getDb()
      .update(applications)
      .set({ capabilities: [] })
      .where(eq(applications.id, VAULT_APP_ID));
    await insertInstall(USER_ID, 'tok-vault', VAULT_APP_ID);
    const { authorizeCode } = await insertRequest();

    const outcome = await deliverAuthRequestToIdentityApps({
      authorizeCode,
      identityUserId: USER_ID,
    });

    expect(outcome).toMatchObject({ delivered: false, targets: 0 });
    expect(mockSendPushToTokens).not.toHaveBeenCalled();
  });
});

describe('deliverAuthRequestToIdentityApps — payload', () => {
  it('sends exactly { type, approvalUrl } and nothing else', async () => {
    await insertInstall(USER_ID, 'tok-vault', VAULT_APP_ID);
    const { authorizeCode } = await insertRequest({
      boundOrigin: 'https://rp.example',
      requesterLabel: 'Chrome on Windows',
    });

    await deliverAuthRequestToIdentityApps({ authorizeCode, identityUserId: USER_ID });

    const call = mockSendPushToTokens.mock.calls[0][0] as {
      userId: string;
      tokens: string[];
      title: string;
      body: string;
      channelId: string;
      data: Record<string, unknown>;
    };

    // Recursive key set of the payload — nothing beyond the two allowed fields.
    expect(collectKeyPaths(call.data).sort()).toEqual(['approvalUrl', 'type']);
    expect(call.data).toEqual({
      type: IDENTITY_APPROVAL_PUSH_TYPE,
      approvalUrl: `oxycommons://approve?v=1&code=${authorizeCode}`,
    });
    expect(IDENTITY_APPROVAL_PUSH_TYPE).toBe('oxy_commons_auth_request');

    // No request-derived display data reaches the notification: not the
    // application's name, not the bound origin, not the requester label. Commons
    // re-fetches all of it from `GET /auth/session/approve-info` behind
    // biometrics.
    const wire = JSON.stringify(call);
    expect(wire).not.toContain('rp.example');
    expect(wire).not.toContain('Chrome on Windows');
    expect(wire).not.toContain(VAULT_APP_ID);

    // The secret sessionToken never leaves the server on this path — and it is
    // really stored, so this assertion is not vacuous.
    expect(wire).not.toContain(SECRET_MARKER);

    // The message carries no action category: an iOS category is what binds
    // action buttons to a notification, and approval must never happen from the
    // notification shade.
    expect(Object.keys(call).sort()).toEqual([
      'body', 'channelId', 'data', 'title', 'tokens', 'userId',
    ]);
    expect(call.channelId).toBe(IDENTITY_APPROVAL_PUSH_CHANNEL);
    expect(call.userId).toBe(USER_ID);
    expect(call.tokens).toEqual(['tok-vault']);
  });

  it('percent-encodes the approval handle in the deep link', () => {
    expect(buildApprovalUrl('a b&c')).toBe('oxycommons://approve?v=1&code=a%20b%26c');
  });
});

describe('deliverAuthRequestToIdentityApps — failure never breaks the auth flow', () => {
  it('returns a well-formed result when the push service throws', async () => {
    await insertInstall(USER_ID, 'tok-vault', VAULT_APP_ID);
    const { authorizeCode, sessionToken } = await insertRequest();
    mockSendPushToTokens.mockRejectedValue(new Error('expo unreachable'));

    const outcome = await deliverAuthRequestToIdentityApps({
      authorizeCode,
      identityUserId: USER_ID,
    });

    expect(outcome).toEqual({ ok: true, sessionToken, delivered: false, targets: 1 });
    // Nothing was delivered, so no progress is recorded.
    expect((await storedRequest(authorizeCode)).pushSentAt).toBeNull();
  });

  it('reports delivered:false when no install accepted the message', async () => {
    await insertInstall(USER_ID, 'tok-vault', VAULT_APP_ID);
    const { authorizeCode } = await insertRequest();
    mockSendPushToTokens.mockResolvedValue({ targeted: 1, accepted: 0 });

    const outcome = await deliverAuthRequestToIdentityApps({
      authorizeCode,
      identityUserId: USER_ID,
    });

    expect(outcome).toMatchObject({ delivered: false, targets: 1 });
    expect((await storedRequest(authorizeCode)).pushSentAt).toBeNull();
  });
});

describe('deliverAuthRequestToIdentityApps — request preconditions', () => {
  it('404s an unknown authorizeCode without touching the push path', async () => {
    await insertInstall(USER_ID, 'tok-vault', VAULT_APP_ID);

    const outcome = await deliverAuthRequestToIdentityApps({
      authorizeCode: randomUUID().replace(/-/g, ''),
      identityUserId: USER_ID,
    });

    expect(outcome).toEqual({ ok: false, status: 404, message: 'Auth session not found' });
    expect(mockSendPushToTokens).not.toHaveBeenCalled();
  });

  it('400s and lazily expires a request whose TTL elapsed', async () => {
    await insertInstall(USER_ID, 'tok-vault', VAULT_APP_ID);
    const { authorizeCode } = await insertRequest({ expiresAt: AN_HOUR_AGO() });

    const outcome = await deliverAuthRequestToIdentityApps({
      authorizeCode,
      identityUserId: USER_ID,
    });

    expect(outcome).toEqual({ ok: false, status: 400, message: 'Auth session has expired' });
    expect((await storedRequest(authorizeCode)).status).toBe('expired');
    expect(mockSendPushToTokens).not.toHaveBeenCalled();
  });

  it('lazily expires ONLY a pending request — a concurrent approval is never overwritten', async () => {
    const { authorizeCode } = await insertRequest({
      expiresAt: AN_HOUR_AGO(),
      status: 'authorized',
    });

    const outcome = await deliverAuthRequestToIdentityApps({
      authorizeCode,
      identityUserId: USER_ID,
    });

    expect(outcome).toEqual({ ok: false, status: 400, message: 'Auth session has expired' });
    expect((await storedRequest(authorizeCode)).status).toBe('authorized');
  });

  it('400s a request that is no longer pending', async () => {
    await insertInstall(USER_ID, 'tok-vault', VAULT_APP_ID);
    const { authorizeCode } = await insertRequest({ status: 'authorized' });

    const outcome = await deliverAuthRequestToIdentityApps({
      authorizeCode,
      identityUserId: USER_ID,
    });

    expect(outcome).toEqual({
      ok: false,
      status: 400,
      message: 'Auth session is no longer pending',
    });
    expect(mockSendPushToTokens).not.toHaveBeenCalled();
  });
});

describe('deliverAuthRequestToIdentityApps — progress is a timestamp', () => {
  it('records pushSentAt without moving status', async () => {
    await insertInstall(USER_ID, 'tok-vault', VAULT_APP_ID);
    const { authorizeCode } = await insertRequest();

    await deliverAuthRequestToIdentityApps({ authorizeCode, identityUserId: USER_ID });

    const row = await storedRequest(authorizeCode);
    expect(row.pushSentAt).toBeInstanceOf(Date);
    // "pushed" is not a status, by construction: the CHECK on `status` lists
    // five values and neither "pushed" nor "opened" is among them.
    expect(row.status).toBe('pending');
  });

  it('never moves pushSentAt forward on a second delivery', async () => {
    await insertInstall(USER_ID, 'tok-vault', VAULT_APP_ID);
    const { authorizeCode } = await insertRequest();

    await deliverAuthRequestToIdentityApps({ authorizeCode, identityUserId: USER_ID });
    const first = (await storedRequest(authorizeCode)).pushSentAt;

    await deliverAuthRequestToIdentityApps({ authorizeCode, identityUserId: USER_ID });

    expect((await storedRequest(authorizeCode)).pushSentAt).toEqual(first);
  });
});

describe('markAuthRequestOpened', () => {
  it('404s an unknown authorizeCode', async () => {
    const outcome = await markAuthRequestOpened(randomUUID().replace(/-/g, ''));

    expect(outcome).toEqual({ ok: false, status: 404, message: 'Auth session not found' });
  });

  it('records openedAt and never touches status', async () => {
    const { authorizeCode, sessionToken } = await insertRequest();

    const outcome = await markAuthRequestOpened(authorizeCode);

    expect(outcome).toEqual({ ok: true, sessionToken, recorded: true });
    const row = await storedRequest(authorizeCode);
    expect(row.openedAt).toBeInstanceOf(Date);
    expect(row.status).toBe('pending');
  });

  it('is idempotent: a repeat call records nothing and leaves the first instant', async () => {
    const { authorizeCode } = await insertRequest();

    await markAuthRequestOpened(authorizeCode);
    const first = (await storedRequest(authorizeCode)).openedAt;

    const repeat = await markAuthRequestOpened(authorizeCode);

    expect(repeat).toMatchObject({ ok: true, recorded: false });
    expect((await storedRequest(authorizeCode)).openedAt).toEqual(first);
  });

  it('records nothing for an already-authorized request', async () => {
    const { authorizeCode } = await insertRequest({ status: 'authorized' });

    const outcome = await markAuthRequestOpened(authorizeCode);

    expect(outcome).toMatchObject({ ok: true, recorded: false });
    const row = await storedRequest(authorizeCode);
    expect(row.openedAt).toBeNull();
    expect(row.status).toBe('authorized');
  });

  it('records nothing for an EXPIRED-but-still-stored request', async () => {
    // `db/expiry.ts` sweeps `auth_sessions` on a one-hour grace, so a request
    // outlives its own deadline on purpose. The read filters `expires_at > now()`
    // itself — dropping that because "the sweep handles it" would let an expired
    // request keep recording progress for up to an hour.
    const { authorizeCode } = await insertRequest({ expiresAt: AN_HOUR_AGO() });

    const outcome = await markAuthRequestOpened(authorizeCode);

    expect(outcome).toMatchObject({ ok: true, recorded: false });
    expect((await storedRequest(authorizeCode)).openedAt).toBeNull();
  });
});
