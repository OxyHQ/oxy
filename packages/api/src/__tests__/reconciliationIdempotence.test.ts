import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../config/postgres';
import { users } from '../db/schema/users';
import { registerExternalIdentity } from '../services/externalIdentityRegistry.service';
import { federationService } from '../services/federation.service';
import type { ExternalActorProfile } from '../services/federation/externalIdentityPolicy';
import { inspectReconciliationChanges } from '../../scripts/reconcile-external-identities';

beforeAll(connectPostgres);
afterAll(closePostgres);
afterEach(() => jest.restoreAllMocks());

function profile(bio: string): ExternalActorProfile {
  const handle = `reconcile${randomUUID().replaceAll('-', '')}`;
  return { actorUri: `https://bird.makeup/users/${handle}`, username: `${handle}@x.com`,
    transportAcct: `${handle}@bird.makeup`, domain: 'x.com', protocol: 'activitypub',
    displayName: 'Reconciliation fixture', bio, evidenceLinks: [] };
}

it.each([
  { before: '', after: '', changed: false },
  { before: 'Previous biography', after: '', changed: true },
  { before: 'Previous biography', after: 'New biography', changed: true },
])('register/apply/preview is idempotent for "$before" → "$after"', async ({ before, after, changed }) => {
  const source = profile(before);
  const registered = await registerExternalIdentity({ canonicalAcct: source.username, actorUri: source.actorUri,
    transportAcct: source.transportAcct, protocol: source.protocol,
    profile: { displayName: source.displayName, bio: source.bio } });
  const incoming = { ...source, bio: after };
  expect(await inspectReconciliationChanges(incoming, source.username)).toBe(changed);
  // Only remote actor fetching is stubbed. Apply uses the actual Oxy resolver,
  // source-bound registry transaction and public-user readback in PostgreSQL.
  jest.spyOn(federationService, 'fetchActorProfile').mockResolvedValue(incoming);
  const applied = await federationService.resolveExternalActorIdentity(source.actorUri);
  expect(applied?.user.id).toBe(registered.userId);
  const [stored] = await getDb().select({ bio: users.bio }).from(users).where(eq(users.id, registered.userId));
  expect(stored.bio).toBe(after || null);
  expect(await inspectReconciliationChanges(incoming, source.username)).toBe(false);
  await federationService.resolveExternalActorIdentity(source.actorUri);
  expect(await inspectReconciliationChanges(incoming, source.username)).toBe(false);
});

it('keeps missing users and changed accounts visible while treating legacy empty strings as empty', async () => {
  const source = profile('');
  expect(await inspectReconciliationChanges(source, source.username)).toBe(true);
  const registered = await registerExternalIdentity({ canonicalAcct: source.username, actorUri: source.actorUri,
    transportAcct: source.transportAcct, protocol: source.protocol,
    profile: { displayName: source.displayName, bio: source.bio } });
  await getDb().update(users).set({ bio: '' }).where(eq(users.id, registered.userId));
  expect(await inspectReconciliationChanges(source, source.username)).toBe(false);
  expect(await inspectReconciliationChanges({ ...source, username: `other${source.username}` }, source.username)).toBe(true);
});
