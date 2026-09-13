import { randomUUID } from 'node:crypto';
import { connectPostgres, closePostgres, getDb } from '../../config/postgres';
import { users } from '../../db/schema/users';
import { externalIdentities, externalIdentityActors } from '../../db/schema/externalIdentities';
import { inspectExternalIdentityCache, validateCacheInspectionInput } from '../externalIdentityCacheInspection.service';
import { eq } from 'drizzle-orm';

beforeAll(connectPostgres);
afterAll(closePostgres);
function input() {
  const local = randomUUID().replaceAll('-', '');
  return { actorUri: `https://bird.makeup/users/${local}`, canonicalAcct: `${local}@x.com`, transportAcct: `${local}@bird.makeup`, sourceSha: 'a'.repeat(40), imageDigest: `sha256:${'b'.repeat(64)}` };
}
it('reports an absent source without registering or resolving it', async () => {
  const request = input();
  const result = await inspectExternalIdentityCache(request);
  expect(result).toMatchObject({ operation: 'inspect_cache', absent: true, sourceSha: request.sourceSha, imageDigest: request.imageDigest, counts: { users: 0, registryActors: 0, registryIdentities: 0 } });
  expect(Number.isFinite(Date.parse(result.observedAt))).toBe(true);
  expect(await inspectExternalIdentityCache(request)).toMatchObject({ absent: true });
});
it('counts a migrated registered source without changing it', async () => {
  const request = input();
  const [user] = await getDb().insert(users).values({ username: request.canonicalAcct, type: 'federated', federationActorUri: request.actorUri }).returning();
  await getDb().insert(externalIdentities).values({ canonicalAcct: request.canonicalAcct, userId: user.id, network: 'x.com' });
  await getDb().insert(externalIdentityActors).values({ actorUri: request.actorUri, canonicalAcct: request.canonicalAcct, transportAcct: request.transportAcct, protocol: 'activitypub' });
  expect(await inspectExternalIdentityCache(request)).toMatchObject({ absent: false, counts: { users: 1, registryActors: 1, registryIdentities: 1 } });
  expect((await getDb().select().from(users).where(eq(users.id, user.id)))[0]).toEqual(user);
});
it.each(['actor', 'canonical', 'transport'])('detects a private archived legacy orphan by %s before any registry exists', async matching => {
  const request = input();
  await getDb().insert(users).values({ username: matching === 'canonical' ? request.canonicalAcct : matching === 'transport' ? request.transportAcct : randomUUID(), type: 'federated', federationActorUri: matching === 'actor' ? request.actorUri : null, privacyIsPrivateAccount: true, accountStatus: 'archived' });
  expect(await inspectExternalIdentityCache(request)).toMatchObject({ absent: false, counts: { users: 1, registryActors: 0, registryIdentities: 0 } });
});
it('rejects injected identifiers and untrusted provenance before database access', () => {
  const request = input();
  expect(() => validateCacheInspectionInput({ ...request, canonicalAcct: "x' OR 1=1--@x.com" })).toThrow();
  expect(() => validateCacheInspectionInput({ ...request, actorUri: 'https://user:password@bird.makeup/users/x' })).toThrow();
  expect(() => validateCacheInspectionInput({ ...request, sourceSha: 'main' })).toThrow();
});
