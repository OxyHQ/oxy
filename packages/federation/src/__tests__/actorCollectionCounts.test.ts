import type { NormalizedExternalActor } from '../index';
import {
  createActorResolver,
  type ActorResolverConfig,
  type FederatedActorRecordBase,
  type FederatedActorUpsert,
} from '../node/actorResolver';

/**
 * A remote collection count that could not be read is UNKNOWN, not zero.
 *
 * `fetchCollectionCount` used to turn every failure — a hidden collection's 403,
 * a timeout, a body with no `totalItems` — into `0`, so the store recorded and
 * the profile showed "0 followers" for accounts with thousands. These pin the
 * three outcomes apart: a reported number (including a real 0), a definitive
 * `null`, and an ABSENT key for a failed attempt, which is what tells the store
 * to keep the value it already has.
 */

interface TestActor extends FederatedActorRecordBase {
  uri: string;
}

const ACTOR = 'https://remote.example/users/bob';
const FOLLOWERS = 'https://remote.example/users/bob/followers';
const FOLLOWING = 'https://remote.example/users/bob/following';
const OUTBOX = 'https://remote.example/users/bob/outbox';

type CollectionReply = Response | (() => Promise<Response>);

function actorDocument(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: ACTOR,
    type: 'Person',
    inbox: 'https://remote.example/users/bob/inbox',
    preferredUsername: 'bob',
    followers: FOLLOWERS,
    following: FOLLOWING,
    outbox: OUTBOX,
    ...overrides,
  });
}

function collection(totalItems: unknown): Response {
  return new Response(JSON.stringify({ type: 'OrderedCollection', totalItems }));
}

async function resolveWith(replies: {
  actor?: string;
  followers?: CollectionReply;
  following?: CollectionReply;
  outbox?: CollectionReply;
}): Promise<{ upserts: FederatedActorUpsert[]; bridged: NormalizedExternalActor[] }> {
  const upserts: FederatedActorUpsert[] = [];
  const bridged: NormalizedExternalActor[] = [];
  const reply = (r: CollectionReply | undefined): Promise<Response> => {
    if (!r) return Promise.resolve(collection(7));
    return typeof r === 'function' ? r() : Promise.resolve(r);
  };

  const config: ActorResolverConfig<TestActor> = {
    federationEnabled: true,
    signedFetch: async (url) => {
      if (url === ACTOR) return new Response(replies.actor ?? actorDocument());
      if (url === FOLLOWERS) return reply(replies.followers);
      if (url === FOLLOWING) return reply(replies.following);
      if (url === OUTBOX) return reply(replies.outbox);
      return new Response(null, { status: 404 });
    },
    fetchWebFinger: async () => null,
    isBlockedDomain: () => false,
    normalizeFederatedAcct: (acct) => acct,
    domainFromAcct: (acct) => acct.split('@')[1],
    firstStringUrl: () => undefined,
    store: {
      findActorByUri: async () => null,
      upsertActor: async (uri, update) => {
        upserts.push(update);
        return { _id: 'row-1', uri };
      },
      findActorByPublicKeyId: async () => null,
      setActorOxyUserId: async () => {},
      tombstoneActor: async () => null,
    },
    identity: {
      resolveExternalUser: async (actor) => {
        bridged.push(actor);
        return null;
      },
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

  await createActorResolver(config).fetchRemoteActor(ACTOR);
  return { upserts, bridged };
}

describe('fetchRemoteActor — remote collection counts', () => {
  it('stores reported totals, and a real 0 stays 0', async () => {
    const { upserts } = await resolveWith({
      followers: collection(1234),
      following: collection(0),
      outbox: collection(56),
    });

    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({ followersCount: 1234, followingCount: 0, postsCount: 56 });
  });

  it.each([401, 403, 404, 410])('records a collection that answers %i as unknown (null), not 0', async (status) => {
    const { upserts } = await resolveWith({
      followers: new Response(null, { status }),
      following: collection(3),
    });

    expect(upserts[0]?.followersCount).toBeNull();
    expect(upserts[0]?.followingCount).toBe(3);
  });

  it.each([
    ['missing', undefined],
    ['a string', '1234'],
    ['negative', -1],
    ['fractional', 1.5],
  ])('records a collection whose totalItems is %s as unknown (null)', async (_label, totalItems) => {
    const { upserts } = await resolveWith({ followers: collection(totalItems) });

    expect(upserts[0]?.followersCount).toBeNull();
  });

  it('records an actor that advertises no collection as unknown (null)', async () => {
    const { upserts } = await resolveWith({
      actor: actorDocument({ followers: undefined, following: undefined }),
    });

    expect(upserts[0]?.followersCount).toBeNull();
    expect(upserts[0]?.followingCount).toBeNull();
  });

  it.each([
    ['a timeout', () => Promise.reject(new Error('The operation was aborted due to timeout'))],
    ['a 500', () => Promise.resolve(new Response(null, { status: 500 }))],
    ['a 429', () => Promise.resolve(new Response(null, { status: 429 }))],
    ['malformed JSON', () => Promise.resolve(new Response('{"totalItems": 12'))],
    ['an empty body', () => Promise.resolve(new Response(''))],
  ] as const)('OMITS a count whose fetch failed with %s, so a known value is kept', async (_label, followers) => {
    const { upserts } = await resolveWith({ followers, following: collection(9) });

    expect(upserts[0]).not.toHaveProperty('followersCount');
    expect(upserts[0]?.followingCount).toBe(9);
  });

  it('never hands the identity bridge a zero it did not read', async () => {
    const { bridged } = await resolveWith({
      followers: new Response(null, { status: 403 }),
      following: () => Promise.reject(new Error('timeout')),
      outbox: collection(0),
    });

    expect(bridged).toHaveLength(1);
    expect(bridged[0]?.followersCount).toBeUndefined();
    expect(bridged[0]?.followingCount).toBeUndefined();
    expect(bridged[0]?.postsCount).toBe(0);
  });
});
