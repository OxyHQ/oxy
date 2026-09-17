import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { users } from '../../db/schema/users';
import { externalIdentities, externalIdentityActors } from '../../db/schema/externalIdentities';
import { federationService } from '../federation.service';
import { inspectExternalProfile } from '../externalProfileInspection.service';
import type { ExternalActorProfile } from '../federation/externalIdentityPolicy';

beforeAll(connectPostgres);
afterAll(closePostgres);
afterEach(() => jest.restoreAllMocks());
async function fixture() {
  const handle = randomUUID().replaceAll('-', '');
  const actorUri = `https://bird.makeup/users/${handle}`;
  const canonicalAcct = `${handle}@x.com`;
  const [user] = await getDb().insert(users).values({ username: canonicalAcct, type: 'federated', federationActorUri: actorUri, bio: 'PRIVATE_BIO_SENTINEL' }).returning();
  await getDb().insert(externalIdentities).values({ canonicalAcct, userId: user.id, network: 'x.com' });
  await getDb().insert(externalIdentityActors).values({ actorUri, canonicalAcct, transportAcct: `${handle}@bird.makeup`, protocol: 'activitypub' });
  const profile: ExternalActorProfile = { actorUri, username: canonicalAcct, domain: 'x.com', transportAcct: `${handle}@bird.makeup`, protocol: 'activitypub', displayName: 'PRIVATE_NAME', bio: user.bio ?? '', evidenceLinks: [] };
  return { user, profile, input: { actorUri, sourceSha: 'a'.repeat(40), imageDigest: `sha256:${'b'.repeat(64)}` } };
}
it('compares one observed profile with the real source user without modifying rows or leaking text', async () => {
  const { user, profile, input } = await fixture();
  const fetch = jest.spyOn(federationService, 'fetchActorProfileResult').mockResolvedValue({ ok: true, profile });
  const report = await inspectExternalProfile(input);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith(input.actorUri, undefined, { readonlySigningKey: true });
  expect(report).toMatchObject({ readOnly: true, sourceBindingStable: true, storedBioStable: true, remoteMatchesStored: true,
    before: { sourceUserId: user.id, exactBindingMatches: true, normalizedBindingMatches: true, sourceCount: 1, identityCount: 1 } });
  expect(report.remote?.bio.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(report)).not.toMatch(/PRIVATE_BIO_SENTINEL|PRIVATE_NAME/);
  expect((await getDb().select().from(users).where(eq(users.id, user.id)))[0]).toEqual(user);
});
it('distinguishes exact-username lookup failure from the registry source binding', async () => {
  const { user, profile, input } = await fixture();
  await getDb().update(users).set({ username: ` ${profile.username.toUpperCase()} ` }).where(eq(users.id, user.id));
  jest.spyOn(federationService, 'fetchActorProfileResult').mockResolvedValue({ ok: true, profile });
  expect(await inspectExternalProfile(input)).toMatchObject({ remoteMatchesStored: true,
    before: { exactUsernameUserId: null, normalizedUsernameUserId: user.id, exactBindingMatches: false, normalizedBindingMatches: true } });
});
it('detects a concurrent bio writer between independent read-only snapshots', async () => {
  const { user, profile, input } = await fixture();
  jest.spyOn(federationService, 'fetchActorProfileResult').mockImplementation(async () => {
    await getDb().update(users).set({ bio: 'CONCURRENT_PRIVATE_BIO' }).where(eq(users.id, user.id));
    return { ok: true, profile };
  });
  const report = await inspectExternalProfile(input);
  expect(report).toMatchObject({ storedBioStable: false, sourceBindingStable: true, remoteMatchesStored: false });
  expect(JSON.stringify(report)).not.toContain('CONCURRENT_PRIVATE_BIO');
});
it('reports source refusal and absent registry without discovery or raw errors', async () => {
  const { input } = await fixture();
  input.actorUri += 'absent';
  jest.spyOn(federationService, 'fetchActorProfileResult').mockResolvedValue({ ok: false, failure: {
    operation: 'resolve_external_identity', phase: 'actor_fetch', reason: 'http_status', httpStatus: 404,
  } });
  expect(await inspectExternalProfile(input)).toMatchObject({ before: { sourceUserId: null, sourceCount: 0 }, remote: null,
    failure: { phase: 'actor_fetch', reason: 'http_status', httpStatus: 404 } });
});
it('rejects non-reviewed, secret-bearing and arbitrary selectors before fetching', async () => {
  const { input } = await fixture();
  const fetch = jest.spyOn(federationService, 'fetchActorProfileResult');
  for (const actorUri of ['https://evil.example/users/x', `${input.actorUri}?token=secret`, 'https://bird.makeup/users/x/extra']) {
    await expect(inspectExternalProfile({ ...input, actorUri })).rejects.toThrow();
  }
  expect(fetch).not.toHaveBeenCalled();
});
it('read-only signing refuses missing keys without bootstrap insertion or remote fetch', async () => {
  const db = getDb();
  jest.spyOn(db, 'select').mockReturnValue({ from: () => ({ where: () => ({ limit: async () => [] }) }) } as unknown as ReturnType<typeof db.select>);
  const insert = jest.spyOn(db, 'insert');
  expect(await federationService.fetchActorProfileResult('https://bird.makeup/users/missingkey', undefined, { readonlySigningKey: true }))
    .toMatchObject({ ok: false, failure: { reason: 'signing_key_unavailable' } });
  expect(insert).not.toHaveBeenCalled();
});

it('exposes associated source writers and a different username-selected user without merging them', async () => {
  const { user, profile, input } = await fixture();
  await getDb().update(users).set({ username: `source${profile.username}` }).where(eq(users.id, user.id));
  const [other] = await getDb().insert(users).values({ username: profile.username, type: 'federated', bio: 'OTHER_PRIVATE_BIO' }).returning();
  await getDb().insert(externalIdentityActors).values({ actorUri: `https://other.example/users/${user.id}`, canonicalAcct: profile.username, transportAcct: `${user.id}@other.example`, protocol: 'activitypub' });
  jest.spyOn(federationService, 'fetchActorProfileResult').mockResolvedValue({ ok: true, profile });
  const report = await inspectExternalProfile(input);
  expect(report.before).toMatchObject({ sourceUserId: user.id, exactUsernameUserId: other.id, normalizedUsernameUserId: other.id,
    exactBindingMatches: false, normalizedBindingMatches: false, sourceCount: 2 });
  expect(report.before.associatedSources).toHaveLength(2);
  expect(JSON.stringify(report)).not.toContain('OTHER_PRIVATE_BIO');
});
