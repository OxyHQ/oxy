/**
 * The device DIRECTORY and the ONE activation write (issue #937, ADR 0002),
 * against a REAL Postgres, a REAL account graph and a REAL session minter.
 *
 * Almost nothing is mocked here, and that is the point. The properties this
 * phase exists to hold are all properties of STORED ROWS under CONCURRENCY —
 * "activating the already-active context bumps nothing", "a revoked target
 * fails closed and heals", "concurrent activations produce one deterministic
 * winning revision". Every one of them is invisible to a suite that mocks the
 * services, because a `jest.fn()` has no revision, no lock and no transaction.
 *
 * What IS mocked:
 *  - `jsonwebtoken`, restored to the REAL signer. The global `jest.setup.cjs`
 *    mock returns a constant string, and `sessions.access_token` is really
 *    UNIQUE here, so a constant would make the second minted session of the
 *    suite die on `sessions_access_token_key`.
 *  - `securityActivityService` — a device-added audit write, not the subject.
 *  - `utils/logger` — noise.
 */

import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { and, eq } from 'drizzle-orm';

jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
jest.mock('../securityActivityService', () => ({
  __esModule: true,
  default: { logDeviceAdded: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { deviceDirectorySchema } from '@oxyhq/contracts';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { accountMembers } from '../../db/schema/accountMembers';
import { deviceAccountContexts } from '../../db/schema/deviceAccountContexts';
import { devicePrincipals } from '../../db/schema/devicePrincipals';
import { deviceSessions } from '../../db/schema/deviceSessions';
import { sessions } from '../../db/schema/sessions';
import { users } from '../../db/schema/users';
import { validateAccessToken } from '../../utils/sessionUtils';
import sessionCache from '../../utils/sessionCache';
import userCache from '../../utils/userCache';
import deviceSessionService, { electReplacementContext } from '../deviceSession.service';
import sessionService from '../session.service';

/** A minimal Express request carrying only what `extractDeviceInfo` reads. */
function request(): Request {
  return {
    headers: {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
      'accept-language': 'en-US',
    },
  } as unknown as Request;
}

const newDeviceId = () => `dev-${randomUUID()}`;

async function account(over: Partial<typeof users.$inferInsert> = {}): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ username: `u-${randomUUID().slice(0, 12)}`, ...over })
    .returning({ id: users.id });
  return row.id;
}

/** An organization one person may act as. */
async function organization(operatorId: string, role: 'owner' | 'admin' = 'admin') {
  const orgId = await account({ kind: 'organization', username: `org-${randomUUID().slice(0, 8)}` });
  await getDb()
    .insert(accountMembers)
    .values({ accountId: orgId, memberUserId: operatorId, role, status: 'active' });
  return orgId;
}

/** Sign a person in on a device, the way the login lanes do. */
async function signIn(deviceId: string, userId: string): Promise<string> {
  const session = await sessionService.createSession(userId, request(), { deviceId });
  await deviceSessionService.addAccount(deviceId, {
    accountId: userId,
    sessionId: session.sessionId,
  });
  return session.sessionId;
}

async function storedDevice(deviceId: string) {
  const [row] = await getDb()
    .select()
    .from(deviceSessions)
    .where(eq(deviceSessions.deviceId, deviceId))
    .limit(1);
  return row;
}

async function storedContexts(deviceId: string) {
  const device = await storedDevice(deviceId);
  return getDb()
    .select({
      id: deviceAccountContexts.id,
      principalId: deviceAccountContexts.principalId,
      accountId: deviceAccountContexts.accountId,
      sessionId: deviceAccountContexts.sessionId,
      principalUserId: devicePrincipals.userId,
    })
    .from(deviceAccountContexts)
    .innerJoin(devicePrincipals, eq(deviceAccountContexts.principalId, devicePrincipals.id))
    .where(eq(deviceAccountContexts.deviceSessionId, device.id));
}

/** The directory's context for one `(person, account)` pair. */
function contextFor(
  directory: { principals: { userId: string; contexts: { accountId: string }[] }[] },
  principalUserId: string,
  accountId: string
) {
  const principal = directory.principals.find((entry) => entry.userId === principalUserId);
  return principal?.contexts.find((context) => context.accountId === accountId);
}

beforeAll(async () => {
  await connectPostgres();
  process.env.ACCESS_TOKEN_SECRET = `access-${randomUUID()}`;
  process.env.REFRESH_TOKEN_SECRET = `refresh-${randomUUID()}`;
  process.env.DEVICE_ID_SALT = 'x'.repeat(48);
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  jest.clearAllMocks();
  sessionCache.clear();
  userCache.clear();
});

describe('GET /session/device/directory — the server-authoritative read model', () => {
  it('reports the person, their own account and every organization they may act as', async () => {
    const device = newDeviceId();
    const nate = await account();
    const org = await organization(nate);
    await signIn(device, nate);

    const directory = await deviceSessionService.getDirectory(device);

    expect(directory.deviceId).toBe(device);
    expect(directory.principals).toHaveLength(1);
    const [principal] = directory.principals;
    expect(principal.userId).toBe(nate);
    expect(principal.authuser).toBe(0);
    expect(principal.contexts.map((context) => context.accountId)).toEqual(
      expect.arrayContaining([nate, org])
    );

    const personal = contextFor(directory, nate, nate);
    expect(personal).toMatchObject({
      relationship: 'self',
      kind: 'personal',
      onDevice: true,
      available: true,
      active: true,
    });

    // The organization is reachable and has a stable id to activate, but no
    // session has been minted for it — that happens on first activation.
    const delegated = contextFor(directory, nate, org);
    expect(delegated).toMatchObject({
      relationship: 'member',
      kind: 'organization',
      onDevice: false,
      available: true,
      active: false,
      lastUsedAt: null,
    });
  });

  it('adding an organization consumes no signed-in-human slot', async () => {
    const device = newDeviceId();
    const nate = await account();
    const alice = await account();
    await organization(nate);
    await signIn(device, nate);
    await signIn(device, alice);

    const directory = await deviceSessionService.getDirectory(device);

    expect(directory.principals.map((principal) => principal.authuser)).toEqual([0, 1]);
  });

  it('names the same organization separately under each person who reaches it', async () => {
    const device = newDeviceId();
    const nate = await account();
    const alice = await account();
    const org = await organization(nate);
    await getDb()
      .insert(accountMembers)
      .values({ accountId: org, memberUserId: alice, role: 'admin', status: 'active' });
    await signIn(device, nate);
    await signIn(device, alice);

    const directory = await deviceSessionService.getDirectory(device);

    const viaNate = contextFor(directory, nate, org);
    const viaAlice = contextFor(directory, alice, org);
    expect(viaNate).toBeDefined();
    expect(viaAlice).toBeDefined();
    // The identifier names the PAIR, not the account — which is the whole
    // reason `activate` takes a `contextId`.
    expect(viaNate?.id).not.toBe(viaAlice?.id);
    expect(viaNate?.accountId).toBe(viaAlice?.accountId);
  });

  it('returns a revoked managed account as unavailable rather than silently dropping it', async () => {
    const device = newDeviceId();
    const nate = await account();
    const org = await organization(nate);
    await signIn(device, nate);

    const before = await deviceSessionService.getDirectory(device);
    const contextId = contextFor(before, nate, org)?.id;
    if (!contextId) throw new Error('the organization context was not materialized');
    // Use it, so the row is one the person has actually seen.
    await deviceSessionService.activateContext(device, contextId, request());

    await getDb()
      .delete(accountMembers)
      .where(and(eq(accountMembers.accountId, org), eq(accountMembers.memberUserId, nate)));

    const after = await deviceSessionService.getDirectory(device);
    const revoked = contextFor(after, nate, org);
    expect(revoked).toBeDefined();
    expect(revoked?.available).toBe(false);
    expect(revoked?.onDevice).toBe(true);
  });

  it('drops a never-used context whose membership went, because there is nothing to explain', async () => {
    const device = newDeviceId();
    const nate = await account();
    const org = await organization(nate);
    await signIn(device, nate);
    await deviceSessionService.getDirectory(device);

    await getDb()
      .delete(accountMembers)
      .where(and(eq(accountMembers.accountId, org), eq(accountMembers.memberUserId, nate)));

    const after = await deviceSessionService.getDirectory(device);
    expect(contextFor(after, nate, org)).toBeUndefined();
    expect((await storedContexts(device)).map((row) => row.accountId)).toEqual([nate]);
  });

  it('never offers a channel: it is a content identity, not a seat', async () => {
    const device = newDeviceId();
    const nate = await account();
    const channel = await account({ kind: 'channel', username: `ch-${randomUUID().slice(0, 8)}` });
    await getDb()
      .insert(accountMembers)
      .values({ accountId: channel, memberUserId: nate, role: 'owner', status: 'active' });
    await signIn(device, nate);

    const directory = await deviceSessionService.getDirectory(device);

    expect(contextFor(directory, nate, channel)).toBeUndefined();
  });

  it('omits an account whose member holds no account:act_as', async () => {
    const device = newDeviceId();
    const nate = await account();
    // `viewer` is deliberately a role that may read an account and never become
    // it, so this is the per-role half of the same authorization question.
    const org = await account({ kind: 'organization', username: `org-${randomUUID().slice(0, 8)}` });
    await getDb()
      .insert(accountMembers)
      .values({ accountId: org, memberUserId: nate, role: 'viewer', status: 'active' });
    await signIn(device, nate);

    const directory = await deviceSessionService.getDirectory(device);

    expect(contextFor(directory, nate, org)).toBeUndefined();
  });

  it('honours a per-member revoke of account:act_as, not just the role', async () => {
    const device = newDeviceId();
    const nate = await account();
    const org = await organization(nate, 'admin');
    await getDb()
      .update(accountMembers)
      .set({ permissionRevokes: ['account:act_as'] })
      .where(and(eq(accountMembers.accountId, org), eq(accountMembers.memberUserId, nate)));
    await signIn(device, nate);

    const directory = await deviceSessionService.getDirectory(device);

    expect(contextFor(directory, nate, org)).toBeUndefined();
  });

  it('is deterministic: two reads of an unchanged device agree and neither advances the revision', async () => {
    const device = newDeviceId();
    const nate = await account();
    await organization(nate);
    await signIn(device, nate);

    const first = await deviceSessionService.getDirectory(device);
    const contextsAfterFirst = (await storedContexts(device)).length;
    const second = await deviceSessionService.getDirectory(device);

    expect(second).toEqual(first);
    expect(second.revision).toBe(first.revision);
    // Materializing an id is idempotent — the second read inserts nothing.
    expect((await storedContexts(device)).length).toBe(contextsAfterFirst);
    // And the revision the device row carries never moved on a READ.
    expect((await storedDevice(device)).revision).toBe(first.revision);
  });

  it('carries a switcher row and nothing that would make it a profile feed', async () => {
    const device = newDeviceId();
    const nate = await account({
      email: `dir-${randomUUID().slice(0, 8)}@example.com`,
      phone: `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`,
      nameFirst: 'Nate',
      nameLast: 'Isern',
      bio: 'a bio nobody asked this endpoint for',
    });
    await signIn(device, nate);

    const directory = await deviceSessionService.getDirectory(device);
    const personal = contextFor(directory, nate, nate);

    expect(Object.keys(personal?.account ?? {}).sort()).toEqual([
      'avatar',
      'color',
      'id',
      'name',
      'username',
    ]);
    expect(personal?.account.name).toEqual({ displayName: 'Nate Isern', first: 'Nate', last: 'Isern', full: 'Nate Isern' });
    const serialized = JSON.stringify(directory);
    expect(serialized).not.toContain('@example.com');
    expect(serialized).not.toContain('a bio nobody asked');
  });

  it('draws every row in its own account’s accent, not one theme accent', async () => {
    const device = newDeviceId();
    const nate = await account({ color: 'purple' });
    const org = await organization(nate);
    await getDb().update(users).set({ color: 'amber' }).where(eq(users.id, org));
    await signIn(device, nate);

    const directory = await deviceSessionService.getDirectory(device);

    const principal = directory.principals.find((entry) => entry.userId === nate);
    expect(principal?.user.color).toBe('purple');
    expect(contextFor(directory, nate, nate)?.account.color).toBe('purple');
    // The row that regressed when the switcher moved onto the directory
    // (issue #961): a non-active row, whose accent no client holds a profile
    // for and can therefore only learn from here.
    expect(contextFor(directory, nate, org)?.account.color).toBe('amber');
  });

  it('keeps the accent on a revoked context, which reads from a different query', async () => {
    const device = newDeviceId();
    const nate = await account();
    const org = await organization(nate);
    await getDb().update(users).set({ color: 'sky' }).where(eq(users.id, org));
    await signIn(device, nate);

    const before = await deviceSessionService.getDirectory(device);
    const contextId = contextFor(before, nate, org)?.id;
    if (!contextId) throw new Error('the organization context was not materialized');
    // Use it, so revoking leaves a reported row rather than dropping it.
    await deviceSessionService.activateContext(device, contextId, request());
    await getDb()
      .delete(accountMembers)
      .where(and(eq(accountMembers.accountId, org), eq(accountMembers.memberUserId, nate)));

    const after = await deviceSessionService.getDirectory(device);

    // A revoked row's profile cannot come from the act-as set it just fell out
    // of, so it is built by the fallback lookup — a SECOND place the accent has
    // to be selected, and one whose omission is invisible in the ordinary case.
    const revoked = contextFor(after, nate, org);
    expect(revoked?.available).toBe(false);
    expect(revoked?.account.color).toBe('sky');
  });

  it('validates its own output against the published contract', async () => {
    const device = newDeviceId();
    const nate = await account();
    await organization(nate);
    await signIn(device, nate);

    const directory = await deviceSessionService.getDirectory(device);

    expect(deviceDirectorySchema.safeParse(directory).success).toBe(true);
  });

  it('answers for a device nobody has signed into yet', async () => {
    const directory = await deviceSessionService.getDirectory(newDeviceId());

    expect(directory.principals).toEqual([]);
    expect(directory.activeContextId).toBeNull();
    expect(directory.revision).toBe(0);
  });
});

describe('POST /session/device/activate — the one write', () => {
  it('mints the delegated session on first activation and binds it to actor AND subject', async () => {
    const device = newDeviceId();
    const nate = await account();
    const org = await organization(nate);
    await signIn(device, nate);
    const before = await deviceSessionService.getDirectory(device);
    const contextId = contextFor(before, nate, org)?.id ?? '';

    const result = await deviceSessionService.activateContext(device, contextId, request());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.accountId).toBe(org);
    expect(result.activeToken?.accessToken).toEqual(expect.any(String));
    expect(result.directory.activeContextId).toBe(contextId);
    expect(result.directory.revision).toBe(before.revision + 1);

    const stored = await storedDevice(device);
    expect(stored.activeContextId).toBe(contextId);
    // `active_account_id` is a PROJECTION of the elected context, derived at the
    // one site that writes either column.
    expect(stored.activeAccountId).toBe(org);

    const [context] = (await storedContexts(device)).filter((row) => row.id === contextId);
    expect(context.sessionId).toEqual(expect.any(String));
    const [minted] = await getDb()
      .select({ userId: sessions.userId, operatedByUserId: sessions.operatedByUserId, deviceId: sessions.deviceId })
      .from(sessions)
      .where(eq(sessions.sessionId, context.sessionId ?? ''))
      .limit(1);
    expect(minted).toMatchObject({ userId: org, operatedByUserId: nate, deviceId: device });
  });

  it('binds the activated session to its context, and says so in the token (#937 Phase 6)', async () => {
    const device = newDeviceId();
    const nate = await account();
    const org = await organization(nate);
    await signIn(device, nate);
    const before = await deviceSessionService.getDirectory(device);
    const contextId = contextFor(before, nate, org)?.id ?? '';

    const result = await deviceSessionService.activateContext(device, contextId, request());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const claims = validateAccessToken(result.activeToken?.accessToken ?? '').payload;
    // The token names the context it was minted for, so a token for the
    // PREVIOUS context can never pass as this one.
    expect(claims?.device_context_id).toBe(contextId);
    expect(claims?.sub).toBe(org);
    expect(claims?.act?.sub).toBe(nate);

    const stored = await storedDevice(device);
    const [session] = await getDb()
      .select({
        deviceSessionId: sessions.deviceSessionId,
        deviceContextId: sessions.deviceContextId,
      })
      .from(sessions)
      .where(eq(sessions.sessionId, result.activeToken ? claims?.sessionId ?? '' : ''))
      .limit(1);
    expect(session).toMatchObject({ deviceSessionId: stored.id, deviceContextId: contextId });
  });

  it('activating the already-active context bumps nothing and reports it changed nothing', async () => {
    const device = newDeviceId();
    const nate = await account();
    const org = await organization(nate);
    await signIn(device, nate);
    const contextId = contextFor(await deviceSessionService.getDirectory(device), nate, org)?.id ?? '';

    const first = await deviceSessionService.activateContext(device, contextId, request());
    const revisionAfterFirst = (await storedDevice(device)).revision;
    const second = await deviceSessionService.activateContext(device, contextId, request());

    expect(first.ok && first.changed).toBe(true);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.changed).toBe(false);
    expect((await storedDevice(device)).revision).toBe(revisionAfterFirst);
    // Idempotent means idempotent: the second call did not mint a second
    // session for the organization either.
    const orgSessions = await getDb()
      .select({ sessionId: sessions.sessionId })
      .from(sessions)
      .where(and(eq(sessions.userId, org), eq(sessions.deviceId, device)));
    expect(orgSessions).toHaveLength(1);
    // …and it still hands the caller a bearer, because it is a success.
    expect(second.activeToken?.accessToken).toEqual(expect.any(String));
  });

  it('reuses the delegated session on a later activation instead of minting a second one', async () => {
    const device = newDeviceId();
    const nate = await account();
    const org = await organization(nate);
    await signIn(device, nate);
    const directory = await deviceSessionService.getDirectory(device);
    const orgContext = contextFor(directory, nate, org)?.id ?? '';
    const personalContext = contextFor(directory, nate, nate)?.id ?? '';

    await deviceSessionService.activateContext(device, orgContext, request());
    const firstSession = (await storedContexts(device)).find((row) => row.id === orgContext)?.sessionId;
    await deviceSessionService.activateContext(device, personalContext, request());
    await deviceSessionService.activateContext(device, orgContext, request());

    expect((await storedContexts(device)).find((row) => row.id === orgContext)?.sessionId).toBe(
      firstSession
    );
  });

  it('fails closed on a revoked delegation and heals the context out of the device', async () => {
    const device = newDeviceId();
    const nate = await account();
    const org = await organization(nate);
    await signIn(device, nate);
    const contextId = contextFor(await deviceSessionService.getDirectory(device), nate, org)?.id ?? '';
    await deviceSessionService.activateContext(device, contextId, request());

    await getDb()
      .delete(accountMembers)
      .where(and(eq(accountMembers.accountId, org), eq(accountMembers.memberUserId, nate)));
    sessionCache.clear();

    const result = await deviceSessionService.activateContext(device, contextId, request());

    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== 'unauthorized') throw new Error('expected unauthorized');
    // Healed, not merely refused: the dead choice is gone from the device.
    expect((await storedContexts(device)).some((row) => row.id === contextId)).toBe(false);
    // …and the device fell back to the same person's own account rather than
    // pointing at something it can no longer mint for.
    const stored = await storedDevice(device);
    expect(stored.activeAccountId).toBe(nate);
    expect(result.directory.activeContextId).toBe(contextFor(result.directory, nate, nate)?.id);
  });

  it('refuses to activate a personal context whose session is gone, and never mints one', async () => {
    const device = newDeviceId();
    const nate = await account();
    const personalSessionId = await signIn(device, nate);
    const contextId = contextFor(await deviceSessionService.getDirectory(device), nate, nate)?.id ?? '';
    await sessionService.deactivateSession(personalSessionId);
    sessionCache.clear();

    const result = await deviceSessionService.activateContext(device, contextId, request());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unauthorized');
    // A personal session is proof that a human authenticated. This endpoint has
    // no such proof, so it must never manufacture one.
    const personalSessions = await getDb()
      .select({ sessionId: sessions.sessionId })
      .from(sessions)
      .where(and(eq(sessions.userId, nate), eq(sessions.deviceId, device)));
    expect(personalSessions).toHaveLength(1);
  });

  it('refuses a delegated context once the person is no longer signed in as themselves', async () => {
    const device = newDeviceId();
    const nate = await account();
    const org = await organization(nate);
    const personalSessionId = await signIn(device, nate);
    const contextId = contextFor(await deviceSessionService.getDirectory(device), nate, org)?.id ?? '';
    await sessionService.deactivateSession(personalSessionId);
    sessionCache.clear();

    const result = await deviceSessionService.activateContext(device, contextId, request());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unauthorized');
  });

  it('404s a context that belongs to a different device', async () => {
    const deviceA = newDeviceId();
    const deviceB = newDeviceId();
    const nate = await account();
    const alice = await account();
    await signIn(deviceA, nate);
    await signIn(deviceB, alice);
    const foreign = contextFor(await deviceSessionService.getDirectory(deviceB), alice, alice)?.id ?? '';

    const result = await deviceSessionService.activateContext(deviceA, foreign, request());

    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('POST /session/device/activate — concurrency', () => {
  it('serializes concurrent activations of ONE context into exactly one revision and one session', async () => {
    const device = newDeviceId();
    const nate = await account();
    const org = await organization(nate);
    await signIn(device, nate);
    const contextId = contextFor(await deviceSessionService.getDirectory(device), nate, org)?.id ?? '';
    const before = (await storedDevice(device)).revision;

    const results = await Promise.all(
      Array.from({ length: 5 }, () => deviceSessionService.activateContext(device, contextId, request()))
    );

    expect(results.every((result) => result.ok)).toBe(true);
    // Exactly one of the five did the work; the other four observed it.
    const changed = results.filter((result) => result.ok && result.changed);
    expect(changed).toHaveLength(1);
    expect((await storedDevice(device)).revision).toBe(before + 1);
    // The race the lock exists to close: without it every caller finds
    // `session_id IS NULL`, every caller mints, and the device ends up with
    // five sessions for one organization.
    const orgSessions = await getDb()
      .select({ sessionId: sessions.sessionId })
      .from(sessions)
      .where(and(eq(sessions.userId, org), eq(sessions.deviceId, device)));
    expect(orgSessions).toHaveLength(1);
  });

  it('advances the revision once per real activation and settles on exactly one winner', async () => {
    const device = newDeviceId();
    const nate = await account();
    const orgs = [await organization(nate), await organization(nate), await organization(nate)];
    await signIn(device, nate);
    const directory = await deviceSessionService.getDirectory(device);
    const contextIds = orgs.map((org) => contextFor(directory, nate, org)?.id ?? '');
    const before = (await storedDevice(device)).revision;

    const results = await Promise.all(
      contextIds.map((contextId) => deviceSessionService.activateContext(device, contextId, request()))
    );

    expect(results.every((result) => result.ok)).toBe(true);
    // Three distinct transitions: no lost update, and no revision reused.
    expect((await storedDevice(device)).revision).toBe(before + 3);
    const stored = await storedDevice(device);
    expect(contextIds).toContain(stored.activeContextId);
    // The projection agrees with the authority, whichever one won.
    const winner = (await storedContexts(device)).find((row) => row.id === stored.activeContextId);
    expect(stored.activeAccountId).toBe(winner?.accountId);
  });
});

describe('removal — one context and one principal are different operations', () => {
  /**
   * Two people, both ACTIVATED into the same organization, so each holds a real
   * delegated session.
   *
   * The activation is what makes the fixture discriminating. A removal that
   * wrongly widens from the PAIR to the ACCOUNT deletes the other person's row
   * too — and the row alone cannot show it, because the directory read that
   * follows re-materializes any pair the person may still act as, with a fresh
   * id and no session. Their SESSION is the thing that does not come back.
   */
  async function sharedOrganization() {
    const device = newDeviceId();
    const nate = await account();
    const alice = await account();
    const org = await organization(nate);
    await getDb()
      .insert(accountMembers)
      .values({ accountId: org, memberUserId: alice, role: 'admin', status: 'active' });
    await signIn(device, nate);
    await signIn(device, alice);
    const directory = await deviceSessionService.getDirectory(device);
    const viaNate = contextFor(directory, nate, org)?.id ?? '';
    const viaAlice = contextFor(directory, alice, org)?.id ?? '';
    await deviceSessionService.activateContext(device, viaNate, request());
    await deviceSessionService.activateContext(device, viaAlice, request());
    const bound = await storedContexts(device);
    return {
      device,
      nate,
      alice,
      org,
      viaNate,
      viaAlice,
      nateOrgSession: bound.find((row) => row.id === viaNate)?.sessionId ?? '',
      aliceOrgSession: bound.find((row) => row.id === viaAlice)?.sessionId ?? '',
    };
  }

  async function sessionIsActive(sessionId: string): Promise<boolean> {
    const [row] = await getDb()
      .select({ isActive: sessions.isActive })
      .from(sessions)
      .where(eq(sessions.sessionId, sessionId))
      .limit(1);
    return row.isActive;
  }

  it('removing one context leaves another person operating the SAME account untouched', async () => {
    const shared = await sharedOrganization();

    const result = await deviceSessionService.removeContext(shared.device, shared.viaNate);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.removedAccountIds).toEqual([shared.org]);
    expect(await sessionIsActive(shared.nateOrgSession)).toBe(false);
    // Alice reaches the organization through her own membership, her own
    // session and her own revocation path. None of them was the unit removed.
    expect(await sessionIsActive(shared.aliceOrgSession)).toBe(true);
    const rows = await storedContexts(shared.device);
    expect(rows.find((row) => row.id === shared.viaAlice)?.sessionId).toBe(shared.aliceOrgSession);
  });

  it('removing one principal takes all of their contexts and nobody else’s', async () => {
    const shared = await sharedOrganization();
    const natePrincipal = (await deviceSessionService.getDirectory(shared.device)).principals.find(
      (principal) => principal.userId === shared.nate
    );
    if (!natePrincipal) throw new Error('nate is not a principal of the device');

    const result = await deviceSessionService.removePrincipal(shared.device, natePrincipal.id);

    expect(result.ok).toBe(true);
    expect(await sessionIsActive(shared.nateOrgSession)).toBe(false);
    expect(await sessionIsActive(shared.aliceOrgSession)).toBe(true);
    const rows = await storedContexts(shared.device);
    expect(rows.every((row) => row.principalUserId === shared.alice)).toBe(true);
    expect(rows.find((row) => row.id === shared.viaAlice)?.sessionId).toBe(shared.aliceOrgSession);
    const principals = await getDb()
      .select({ userId: devicePrincipals.userId })
      .from(devicePrincipals)
      .innerJoin(deviceSessions, eq(devicePrincipals.deviceSessionId, deviceSessions.id))
      .where(eq(deviceSessions.deviceId, shared.device));
    expect(principals.map((row) => row.userId)).toEqual([shared.alice]);
  });

  it('a delegated context the person may still act as comes back as merely reachable', async () => {
    const device = newDeviceId();
    const nate = await account();
    const org = await organization(nate);
    await signIn(device, nate);
    const contextId = contextFor(await deviceSessionService.getDirectory(device), nate, org)?.id ?? '';
    await deviceSessionService.activateContext(device, contextId, request());

    const result = await deviceSessionService.removeContext(device, contextId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Removal signs the organization OUT of this device; it cannot cancel a
    // membership, so the switcher legitimately offers it again — unused.
    const reachable = contextFor(result.directory, nate, org);
    expect(reachable).toMatchObject({ onDevice: false, available: true, lastUsedAt: null });
    expect(reachable?.id).not.toBe(contextId);
  });

  it('elects the same person’s own account when their active context is removed', async () => {
    const device = newDeviceId();
    const nate = await account();
    const org = await organization(nate);
    await signIn(device, nate);
    const directory = await deviceSessionService.getDirectory(device);
    const orgContext = contextFor(directory, nate, org)?.id ?? '';
    await deviceSessionService.activateContext(device, orgContext, request());
    const revisionBefore = (await storedDevice(device)).revision;

    const result = await deviceSessionService.removeContext(device, orgContext);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.directory.activeContextId).toBe(contextFor(result.directory, nate, nate)?.id);
    expect((await storedDevice(device)).revision).toBe(revisionBefore + 1);
  });

  it('404s a context or principal that is not on this device', async () => {
    const device = newDeviceId();
    await signIn(device, await account());

    expect(await deviceSessionService.removeContext(device, randomUUID())).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(await deviceSessionService.removePrincipal(device, randomUUID())).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });
});

describe('electReplacementContext', () => {
  const context = (
    contextId: string,
    principalId: string,
    principalUserId: string,
    accountId: string
  ) => ({
    contextId,
    principalId,
    principalUserId,
    authuser: 0,
    accountId,
    sessionId: 's',
    lastUsedAt: null,
  });

  const nate = { id: 'p-nate', authuser: 0 };
  const alice = { id: 'p-alice', authuser: 1 };

  it('prefers the same person’s own account', () => {
    const remaining = [
      context('c-nate-org', 'p-nate', 'nate', 'org'),
      context('c-nate-self', 'p-nate', 'nate', 'nate'),
      context('c-alice-self', 'p-alice', 'alice', 'alice'),
    ];

    expect(electReplacementContext(remaining, [nate, alice], 'p-nate')?.contextId).toBe('c-nate-self');
  });

  it('falls back to another of the same person’s contexts before changing person', () => {
    const remaining = [
      context('c-alice-self', 'p-alice', 'alice', 'alice'),
      context('c-nate-org-b', 'p-nate', 'nate', 'org-b'),
      context('c-nate-org-a', 'p-nate', 'nate', 'org-a'),
    ];

    // Ordered by account id, so the choice does not depend on read order.
    expect(electReplacementContext(remaining, [nate, alice], 'p-nate')?.contextId).toBe('c-nate-org-a');
  });

  it('moves to the NEXT person’s own account, in authuser order', () => {
    const carol = { id: 'p-carol', authuser: 2 };
    const remaining = [
      context('c-carol-self', 'p-carol', 'carol', 'carol'),
      context('c-alice-self', 'p-alice', 'alice', 'alice'),
    ];

    expect(electReplacementContext(remaining, [carol, alice], 'p-nate')?.contextId).toBe('c-alice-self');
  });

  it('elects nothing rather than guessing when no personal context is left', () => {
    const remaining = [context('c-alice-org', 'p-alice', 'alice', 'org')];

    expect(electReplacementContext(remaining, [alice], 'p-nate')).toBeNull();
  });

  it('elects nothing when nothing is left at all', () => {
    expect(electReplacementContext([], [], 'p-nate')).toBeNull();
  });
});
