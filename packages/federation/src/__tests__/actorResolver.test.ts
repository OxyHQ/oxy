import { createDomainPolicy } from '../apUri';
import { createActorResolver, type ActorResolverConfig, type FederatedActorRecordBase } from '../node/actorResolver';

/**
 * The instance domain policy applies to CACHED actors, not just fetched ones.
 *
 * `fetchRemoteActor` has always refused a blocked host before doing network I/O,
 * but `getOrFetchActor` served its cache hit above that check — so for every
 * instance we had already stored an actor for (which is every instance that has
 * ever reached us), adding its domain to the blocklist changed nothing at all.
 * These lock the cached branch closed and prove the fetching branch still works.
 */

interface TestActor extends FederatedActorRecordBase {
  uri: string;
}

const BLOCKED_ACTOR = 'https://spam.example/users/mallory';
const ALLOWED_ACTOR = 'https://remote.example/users/bob';

function makeResolver(
  overrides: {
    cached?: TestActor | null;
    cachedKey?: Pick<TestActor, 'uri' | 'publicKeyPem'> | null;
    blockedHosts?: string[];
  } = {},
) {
  const blockedHosts = overrides.blockedHosts ?? ['spam.example'];
  const domainPolicy = createDomainPolicy({
    domain: 'mention.earth',
    blockedDomains: blockedHosts,
  });
  const findActorByUriCalls: string[] = [];
  const signedFetchCalls: string[] = [];

  const config: ActorResolverConfig<TestActor> = {
    federationEnabled: true,
    signedFetch: async (url) => {
      signedFetchCalls.push(url);
      // A 404 ends `fetchRemoteActor` without exercising the parse/upsert path;
      // these tests only care about WHETHER the fetch was attempted.
      return new Response(null, { status: 404 });
    },
    fetchWebFinger: async () => null,
    isBlockedDomain: domainPolicy.isBlockedDomain,
    normalizeFederatedAcct: (acct) => acct,
    domainFromAcct: (acct) => acct.split('@')[1],
    firstStringUrl: () => undefined,
    store: {
      findActorByUri: async (uri) => {
        findActorByUriCalls.push(uri);
        return overrides.cached ?? null;
      },
      upsertActor: async () => null,
      findActorByPublicKeyId: async () => overrides.cachedKey ?? null,
      setActorOxyUserId: async () => {},
      tombstoneActor: async () => null,
    },
    identity: {
      resolveExternalUser: async () => null,
      reportActorGone: async () => 'archived',
    },
    text: {
      inlineField: (value) => (typeof value === 'string' ? value : ''),
      inlineDisplayName: (raw) => raw,
      sanitizeFieldValue: (html) => html,
      htmlToPlainText: (html) => html,
    },
    logger: { info: () => {}, warn: () => {} },
  };

  return { resolver: createActorResolver(config), findActorByUriCalls, signedFetchCalls };
}

describe('getOrFetchActor — instance domain policy', () => {
  it('refuses a blocked domain whose actor is ALREADY CACHED', async () => {
    const rig = makeResolver({ cached: { uri: BLOCKED_ACTOR, lastFetchedAt: new Date() } });
    await expect(rig.resolver.getOrFetchActor(BLOCKED_ACTOR)).resolves.toBeNull();
  });

  it('refuses before reading the actor cache at all', async () => {
    const rig = makeResolver({ cached: { uri: BLOCKED_ACTOR, lastFetchedAt: new Date() } });
    await rig.resolver.getOrFetchActor(BLOCKED_ACTOR);
    expect(rig.findActorByUriCalls).toHaveLength(0);
  });

  // Pre-existing behaviour (`fetchRemoteActor` has always refused a blocked host);
  // held here so the uncached branch cannot regress alongside the cached one.
  it('refuses a blocked domain with no cached actor, without any network I/O', async () => {
    const rig = makeResolver({ cached: null });
    await expect(rig.resolver.getOrFetchActor(BLOCKED_ACTOR)).resolves.toBeNull();
    expect(rig.signedFetchCalls).toHaveLength(0);
  });

  it('refuses a STALE cached row for a blocked domain, and refreshes nothing', async () => {
    const stale = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const rig = makeResolver({ cached: { uri: BLOCKED_ACTOR, lastFetchedAt: stale } });
    // Staleness used to pick the background-refresh branch and STILL hand the
    // caller the cached row; the row must now not be returned at all.
    await expect(rig.resolver.getOrFetchActor(BLOCKED_ACTOR)).resolves.toBeNull();
    // Let any detached refresh promise settle before asserting nothing was sent.
    await new Promise((resolve) => setImmediate(resolve));
    expect(rig.signedFetchCalls).toHaveLength(0);
  });

  it('fails closed on an actor URI with no parseable host', async () => {
    const rig = makeResolver({ cached: { uri: 'not-a-uri' } });
    await expect(rig.resolver.getOrFetchActor('not-a-uri')).resolves.toBeNull();
    expect(rig.findActorByUriCalls).toHaveLength(0);
  });

  it('still returns a cached actor for an allowed domain', async () => {
    const cached: TestActor = { uri: ALLOWED_ACTOR, lastFetchedAt: new Date() };
    const rig = makeResolver({ cached });
    await expect(rig.resolver.getOrFetchActor(ALLOWED_ACTOR)).resolves.toBe(cached);
  });

  it('still fetches an allowed domain that is not cached', async () => {
    const rig = makeResolver({ cached: null });
    await rig.resolver.getOrFetchActor(ALLOWED_ACTOR);
    expect(rig.signedFetchCalls).toEqual([ALLOWED_ACTOR]);
  });
});

describe('fetchPublicKey — signature lookups stay honest', () => {
  it('serves a cached key for a blocked domain, so its signature is judged on merit', async () => {
    const rig = makeResolver({ cachedKey: { uri: BLOCKED_ACTOR, publicKeyPem: 'PEM' } });
    await expect(rig.resolver.fetchPublicKey(`${BLOCKED_ACTOR}#main-key`)).resolves.toEqual({
      publicKeyPem: 'PEM',
      actorUri: BLOCKED_ACTOR,
    });
  });

  it('will not resolve a blocked domain key that would require network I/O', async () => {
    const rig = makeResolver({ cachedKey: null, cached: null });
    await expect(rig.resolver.fetchPublicKey(`${BLOCKED_ACTOR}#main-key`)).resolves.toBeNull();
    expect(rig.signedFetchCalls).toHaveLength(0);
  });
});
