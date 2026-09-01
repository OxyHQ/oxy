/**
 * The authority behind a follow operation, and where it may NOT come from.
 *
 * #809's rule is that the user authorizes and the application delegates. These
 * tests pin the two halves that make that true in practice: the application is
 * derived from the server's own authorization record, and the scopes come from
 * the user's revocable grant rather than from what the application is permitted
 * to ask for.
 */

import { and, eq } from 'drizzle-orm';
import { getDb, closePostgres, connectPostgres } from '../../config/postgres';
import { appGrants } from '../../db/schema/appGrants';
import { applications } from '../../db/schema/applications';
import { authSessions } from '../../db/schema/authSessions';
import { users } from '../../db/schema/users';
import {
  assertFollowScopes,
  missingFollowScope,
  resolveFollowCapability,
  type FollowCapability,
} from '../followCapability.service';

let userId: string;
let applicationId: string;
let otherApplicationId: string;

const SESSION = 'session-under-test';

async function makeApplication(name: string, status: 'active' | 'suspended' = 'active') {
  const [app] = await getDb()
    .insert(applications)
    // `owner_account_id` is NOT NULL — an application always belongs to someone.
    .values({ name, status, ownerAccountId: userId })
    .returning({ id: applications.id });
  return app.id;
}

let authSessionCounter = 0;

async function authorize(sessionId: string, appId: string, subject = userId) {
  authSessionCounter += 1;
  await getDb().insert(authSessions).values({
    // `session_token` is the row's own handle and is NOT NULL; unique per row so
    // repeated authorizations in one test cannot collide.
    sessionToken: `auth-session-token-${authSessionCounter}`,
    // NOT NULL. Far enough out that nothing under test reads it as expired.
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    applicationId: appId,
    authorizedSessionId: sessionId,
    authorizedUserId: subject,
    status: 'authorized',
  });
}

async function grant(appId: string, scopes: string[], subject = userId) {
  await getDb().insert(appGrants).values({ userId: subject, applicationId: appId, scopes });
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(async () => {
  const [user] = await getDb().insert(users).values({}).returning({ id: users.id });
  userId = user.id;
  applicationId = await makeApplication('Asking app');
  otherApplicationId = await makeApplication('Some other app');
});

describe('resolveFollowCapability', () => {
  it('derives the application from the authorization record, not from the caller', async () => {
    await authorize(SESSION, applicationId);
    await grant(applicationId, ['follows:read', 'follows:write']);

    const result = await resolveFollowCapability(userId, SESSION);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.capability.applicationId).toBe(applicationId);
    expect(result.capability.scopes).toEqual(['follows:read', 'follows:write']);
    expect(result.capability.userId).toBe(userId);
  });

  it('carries the grant id, so a relationship can record which consent produced it', async () => {
    await authorize(SESSION, applicationId);
    await grant(applicationId, ['follows:write']);

    const result = await resolveFollowCapability(userId, SESSION);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [row] = await getDb()
      .select({ id: appGrants.id })
      .from(appGrants)
      .where(and(eq(appGrants.userId, userId), eq(appGrants.applicationId, applicationId)))
      .limit(1);
    expect(result.capability.grantId).toBe(row.id);
  });

  it('refuses a session no application ever authorized', async () => {
    // A password sign-in on Commons, for instance. Nobody delegated anything,
    // so there is nothing to act on the user's behalf with.
    await grant(applicationId, ['follows:write']);

    const result = await resolveFollowCapability(userId, 'session-nobody-authorized');

    expect(result).toEqual({ ok: false, reason: 'no_application' });
  });

  it('refuses when the user has granted the application nothing', async () => {
    await authorize(SESSION, applicationId);

    const result = await resolveFollowCapability(userId, SESSION);

    expect(result).toEqual({ ok: false, reason: 'no_grant' });
  });

  it('never falls back to what the application is ALLOWED to request', async () => {
    // `applications.scopes` is the app's ceiling; the grant is the user's
    // decision. Reading the ceiling here would reintroduce exactly the bypass
    // #809 exists to close, so an app with every scope available and no grant
    // still gets nothing.
    const permissive = await makeApplication('App with a wide ceiling');
    await getDb()
      .update(applications)
      .set({ scopes: ['follows:read', 'follows:write', 'follows:manage'] })
      .where(eq(applications.id, permissive));
    await authorize(SESSION, permissive);

    const result = await resolveFollowCapability(userId, SESSION);

    expect(result).toEqual({ ok: false, reason: 'no_grant' });
  });

  it('refuses once the application is no longer active', async () => {
    // The grant survives a suspension — the user's record of having authorized
    // it should not be erased — but the app cannot act while suspended.
    await authorize(SESSION, applicationId);
    await grant(applicationId, ['follows:write']);
    await getDb()
      .update(applications)
      .set({ status: 'suspended' })
      .where(eq(applications.id, applicationId));

    const result = await resolveFollowCapability(userId, SESSION);

    expect(result).toEqual({ ok: false, reason: 'application_inactive' });
    const [survivingGrant] = await getDb()
      .select({ id: appGrants.id })
      .from(appGrants)
      .where(and(eq(appGrants.userId, userId), eq(appGrants.applicationId, applicationId)))
      .limit(1);
    expect(survivingGrant).toBeDefined();
  });

  it('reads ANOTHER application grant as nothing, however permissive that grant is', async () => {
    // The forgery this is really guarding: consenting to one app must not let a
    // different one act. The session names its own application, and only that
    // application's grant is consulted.
    await authorize(SESSION, applicationId);
    await grant(otherApplicationId, ['follows:read', 'follows:write', 'follows:manage']);

    const result = await resolveFollowCapability(userId, SESSION);

    expect(result).toEqual({ ok: false, reason: 'no_grant' });
  });

  it('never reads a DIFFERENT user grant for the same session id', async () => {
    const [stranger] = await getDb().insert(users).values({}).returning({ id: users.id });
    await authorize(SESSION, applicationId, stranger.id);
    await grant(applicationId, ['follows:write'], stranger.id);

    const result = await resolveFollowCapability(userId, SESSION);

    expect(result).toEqual({ ok: false, reason: 'no_application' });
  });
});

describe('missingFollowScope', () => {
  const capability: FollowCapability = {
    userId: 'u',
    applicationId: 'a',
    grantId: 'g',
    scopes: ['follows:read'],
    sessionId: 's',
  };

  it('names the scope that is missing rather than answering yes or no', () => {
    // "This app has not been granted permission to change who you follow" is
    // actionable; a 403 with no subject is not.
    expect(missingFollowScope(capability, ['follows:read', 'follows:write'])).toBe('follows:write');
  });

  it('answers null when every required scope is held', () => {
    expect(missingFollowScope(capability, ['follows:read'])).toBeNull();
    expect(missingFollowScope(capability, [])).toBeNull();
  });
});

describe('assertFollowScopes', () => {
  it('refuses to gate a non-follow scope through follow authorization', () => {
    // A typo or a scope from another domain reaching this path would otherwise
    // become a permanently-denied request with no obvious cause.
    expect(() => assertFollowScopes(['follows:write', 'files:read'])).toThrow('files:read');
  });

  it('accepts the follow family', () => {
    expect(() => assertFollowScopes(['follows:read', 'follows:manage'])).not.toThrow();
  });
});
