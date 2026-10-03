/** Additive 0137 constraints against the real migrated PostgreSQL, no auth mocks. */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../../config/postgres';
import { users } from '../users';
import { userAuthMethods } from '../userAuthMethods';
import { sessions } from '../sessions';
import { authCodes } from '../authCodes';
import { applications } from '../applications';
import { appGrants } from '../appGrants';
import { serviceActingAsAuthorityEpochs } from '../serviceActingAsAuthorityEpochs';

beforeAll(connectPostgres);
afterAll(closePostgres);

async function fixture() {
  const [actor] = await getDb().insert(users).values({ kind: 'bot' }).returning();
  const [subject] = await getDb().insert(users).values({ kind: 'organization' }).returning();
  const [key] = await getDb().insert(userAuthMethods).values({
    userId: actor.id, type: 'agent_key', methodPublicKey: randomUUID(),
    label: 'fixture', enrollmentMethod: 'governor',
  }).returning();
  const [app] = await getDb().insert(applications).values({ name: 'fixture', ownerAccountId: actor.id }).returning();
  return { actor, subject, key, app };
}

function sessionValues(userId: string, authMethodId: string | null, ownerId: string | null, operator: string | null = null) {
  return {
    userId, authMethodId, authMethodOwnerId: ownerId, operatedByUserId: operator,
    sessionId: randomUUID(), deviceId: randomUUID(), deviceType: 'server', platform: 'test',
    accessToken: randomUUID(), refreshToken: randomUUID(), expiresAt: new Date(Date.now() + 60_000),
  };
}

it('keeps ordinary sessions valid without any method provenance', async () => {
  const { actor } = await fixture();
  const [session] = await getDb().insert(sessions).values(sessionValues(actor.id, null, null)).returning();
  expect(session.authMethodId).toBeNull();
});

it('retains a bot signer while the effective subject is an organization, including OAuth code', async () => {
  const { actor, subject, key, app } = await fixture();
  const [session] = await getDb().insert(sessions).values(sessionValues(subject.id, key.id, actor.id, actor.id)).returning();
  const [code] = await getDb().insert(authCodes).values({
    userId: subject.id, operatedByUserId: actor.id, authMethodId: key.id, authMethodOwnerId: actor.id,
    applicationId: app.id, codeHash: randomUUID(), redirectUri: 'https://fixture.invalid/callback',
    expiresAt: new Date(Date.now() + 60_000),
  }).returning();
  expect(session.authMethodOwnerId).toBe(actor.id);
  expect(code.authMethodOwnerId).toBe(actor.id);
});

it('rejects a method from a different owner even when the owner equals the effective subject', async () => {
  const { subject, key } = await fixture();
  await expect(getDb().insert(sessions).values(sessionValues(subject.id, key.id, subject.id)))
    .rejects.toMatchObject({ cause: { code: '23503' } });
});

it('rejects dropping or substituting signer provenance', async () => {
  const { actor, subject, key } = await fixture();
  await expect(getDb().insert(sessions).values(sessionValues(actor.id, key.id, null)))
    .rejects.toMatchObject({ cause: { code: '23514' } });
  await expect(getDb().insert(sessions).values(sessionValues(subject.id, key.id, actor.id)))
    .rejects.toMatchObject({ cause: { code: '23514' } });
});

it('revocation preserves a tombstone and prevents deleting the key behind a retained session', async () => {
  const { actor, key } = await fixture();
  await getDb().insert(sessions).values(sessionValues(actor.id, key.id, actor.id));
  await getDb().update(userAuthMethods).set({ revokedAt: new Date() }).where(eq(userAuthMethods.id, key.id));
  await expect(getDb().delete(userAuthMethods).where(eq(userAuthMethods.id, key.id)))
    .rejects.toMatchObject({ cause: { code: '23503' } });
});

it('account deletion cascades through self and delegated sessions/codes without nulling provenance', async () => {
  const { actor, subject, key, app } = await fixture();
  await getDb().insert(sessions).values([
    sessionValues(actor.id, key.id, actor.id),
    sessionValues(subject.id, key.id, actor.id, actor.id),
  ]);
  await getDb().insert(authCodes).values({
    userId: subject.id, operatedByUserId: actor.id, authMethodId: key.id, authMethodOwnerId: actor.id,
    applicationId: app.id, codeHash: randomUUID(), redirectUri: 'https://fixture.invalid/callback',
    expiresAt: new Date(Date.now() + 60_000),
  });
  await getDb().delete(users).where(eq(users.id, actor.id));
  expect(await getDb().select().from(sessions).where(eq(sessions.authMethodId, key.id))).toEqual([]);
  expect(await getDb().select().from(authCodes).where(eq(authCodes.authMethodId, key.id))).toEqual([]);
  expect(await getDb().select().from(userAuthMethods).where(eq(userAuthMethods.id, key.id))).toEqual([]);
});

it('durable epochs survive grant delete/regrant and preserve integers beyond Number.MAX_SAFE_INTEGER', async () => {
  const { actor, app } = await fixture();
  const pair = { userId: actor.id, applicationId: app.id };
  await getDb().insert(serviceActingAsAuthorityEpochs).values({ ...pair, epoch: BigInt('9007199254740993') });
  await getDb().insert(appGrants).values({ ...pair, scopes: ['acting-as:offline'] });
  await getDb().delete(appGrants).where(eq(appGrants.userId, actor.id));
  await getDb().insert(appGrants).values({ ...pair, scopes: ['acting-as:offline'] });
  const [row] = await getDb().select().from(serviceActingAsAuthorityEpochs).where(eq(serviceActingAsAuthorityEpochs.userId, actor.id));
  expect(row.epoch.toString()).toBe('9007199254740993');
  await expect(getDb().update(serviceActingAsAuthorityEpochs).set({ epoch: sql`-1` }).where(eq(serviceActingAsAuthorityEpochs.userId, actor.id)))
    .rejects.toMatchObject({ cause: { code: '23514' } });
});
