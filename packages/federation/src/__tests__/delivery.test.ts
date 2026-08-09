import { Readable } from 'node:stream';
import { createDomainPolicy } from '../apUri';
import {
  createDeliveryService,
  type DeliveryServiceConfig,
  type DeliveryActorFields,
  type DeliveryQueueJob,
  type DeliverSingleHopResult,
} from '../node/delivery';
import { createUrlBuilders } from '../urls';
import { AP_CONTEXT } from '../apContext';
import type { HttpSignatureSigner } from '../httpSignature';

/**
 * Phase 4a delivery + follow-lifecycle proof.
 *
 * The follow-protocol activities (Follow / Accept / Undo(Follow)) and the
 * shared-inbox fan-out dedup are load-bearing bytes on the wire, so this suite
 * locks their exact shape + the `@context` each one carries (a bare AS2 string for
 * Follow; the full quote/poll `AP_CONTEXT` for Undo/Accept/Update) and the
 * dedup/fallback behaviour of `deliverToFollowers`.
 */

const DOMAIN = 'mention.earth';
const urls = createUrlBuilders(DOMAIN);

interface StoredActor extends DeliveryActorFields {
  uri: string;
}

/** A capturing test rig: records every delivered/queued activity + enqueue jobs. */
function makeRig(overrides: {
  actorsByUri?: Record<string, StoredActor>;
  followerActorUris?: string[];
  followerInboxes?: Record<string, { sharedInboxUrl?: string | null; inboxUrl?: string | null }>;
  enqueueReturns?: boolean;
  federationEnabled?: boolean;
  sharingEnabled?: boolean;
  assertSafeInboxUrl?: DeliveryServiceConfig<StoredActor>['assertSafeInboxUrl'];
  blockedHosts?: string[];
} = {}) {
  const deliveredBodies: Array<{ url: string; body: string }> = [];
  const enqueued: DeliveryQueueJob[] = [];
  const fallbackCreates: Array<DeliveryQueueJob & { nextAttemptAt: Date }> = [];
  const fallbackInserts: Array<DeliveryQueueJob & { nextAttemptAt: Date }> = [];
  const upsertedFollows: Array<{ localOxyUserId: string; remoteActorUri: string; activityId: string }> = [];
  const deletedFollowIds: unknown[] = [];
  const refreshedInBackground: string[] = [];

  const sign: HttpSignatureSigner = async () => 'TESTSIG';
  const domainPolicy =
    overrides.blockedHosts === undefined
      ? createDomainPolicy({ domain: DOMAIN })
      : createDomainPolicy({ domain: DOMAIN, blockedDomains: overrides.blockedHosts });

  const config: DeliveryServiceConfig<StoredActor> = {
    federationEnabled: overrides.federationEnabled ?? true,
    userAgent: 'Mention/mention.earth (ActivityPub)',
    apContentType: 'application/activity+json',
    keys: {
      getPublicKey: async () => ({ keyId: `${urls.actor('alice')}#main-key`, publicKeyPem: 'PEM' }),
      sign,
    },
    urls,
    deliverSingleHop: async (url, init): Promise<DeliverSingleHopResult> => {
      deliveredBodies.push({ url, body: init.body });
      // 202 Accepted — success path (response body destroyed, never read).
      return { response: Readable.from([]) as unknown as DeliverSingleHopResult['response'], status: 202 };
    },
    assertSafeInboxUrl: overrides.assertSafeInboxUrl ?? (async () => ({ ok: true })),
    transport: {
      enqueueDelivery: async (job) => {
        enqueued.push(job);
        return overrides.enqueueReturns ?? true;
      },
      fallbackQueue: {
        create: async (job) => {
          fallbackCreates.push(job);
          return job;
        },
        insertMany: async (jobs) => {
          fallbackInserts.push(...jobs);
          return jobs;
        },
      },
    },
    store: {
      findActorByUri: async (uri) => overrides.actorsByUri?.[uri] ?? null,
      findActorInboxesByUris: async (uris) =>
        uris
          .map((u) => overrides.followerInboxes?.[u])
          .filter((a): a is { sharedInboxUrl?: string | null; inboxUrl?: string | null } => a !== undefined),
    },
    follows: {
      listAcceptedInboundFollowerActorUris: async () => overrides.followerActorUris ?? [],
      upsertOutboundPending: async (localOxyUserId, remoteActorUri, activityId) => {
        upsertedFollows.push({ localOxyUserId, remoteActorUri, activityId });
      },
      findOutbound: async (_localOxyUserId, remoteActorUri) => {
        const actor = overrides.actorsByUri?.[remoteActorUri];
        return actor ? { _id: actor._id, activityId: `${urls.actor('alice')}/follows/${String(actor._id)}` } : null;
      },
      deleteById: async (id) => {
        deletedFollowIds.push(id);
      },
    },
    actorRefresh: {
      refreshActorInBackground: (uri) => {
        refreshedInBackground.push(uri);
      },
      fetchRemoteActor: async (uri) => overrides.actorsByUri?.[uri] ?? null,
    },
    consent: { isSharingEnabled: async () => overrides.sharingEnabled ?? true },
    identity: {
      resolveUserByUsername: async () => ({
        name: { displayName: 'Alice' },
        bio: 'hi',
        avatar: 'https://cdn.example/a.png',
        createdAt: '2020-01-01T00:00:00.000Z',
      }),
    },
    profile: { getBanner: async () => 'https://cdn.example/banner.png' },
    buildLocalActorObject: (params) => ({ id: urls.actor(params.username), type: 'Person', name: params.displayName }),
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    isBlockedDomain: domainPolicy.isBlockedDomain,
  };

  return {
    service: createDeliveryService(config),
    deliveredBodies,
    enqueued,
    fallbackCreates,
    fallbackInserts,
    upsertedFollows,
    deletedFollowIds,
    refreshedInBackground,
  };
}

/** Flush pending microtasks so a fire-and-forget `void deliver(...)` runs. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const RealDate = Date;
beforeAll(() => {
  const FIXED_MS = RealDate.parse('2026-07-16T12:00:00.000Z');
  class FixedDate extends RealDate {
    constructor(...args: ConstructorParameters<typeof Date>) {
      if (args.length === 0) super(FIXED_MS);
      else super(...args);
    }
    static now(): number {
      return FIXED_MS;
    }
  }
  (globalThis as { Date: typeof Date }).Date = FixedDate as unknown as typeof Date;
});
afterAll(() => {
  (globalThis as { Date: typeof Date }).Date = RealDate;
});

describe('sendFollow', () => {
  it('delivers the exact Follow activity (bare AS2 @context) and records the outbound follow', async () => {
    const remote = 'https://remote.example/users/bob';
    const rig = makeRig({
      actorsByUri: {
        [remote]: { _id: 'ACTID', uri: remote, inboxUrl: 'https://remote.example/inbox' },
      },
    });

    const result = await rig.service.sendFollow('u-alice', 'alice', remote);
    await flush();

    expect(result).toEqual({ success: true, pending: false });
    expect(rig.refreshedInBackground).toEqual([remote]);
    expect(rig.upsertedFollows).toEqual([
      { localOxyUserId: 'u-alice', remoteActorUri: remote, activityId: `${urls.actor('alice')}/follows/ACTID` },
    ]);
    // Byte-frozen Follow activity — the bare AS2 context (NOT the full AP_CONTEXT).
    expect(rig.deliveredBodies).toHaveLength(1);
    expect(rig.deliveredBodies[0].url).toBe('https://remote.example/inbox');
    expect(rig.deliveredBodies[0].body).toBe(
      `{"@context":"https://www.w3.org/ns/activitystreams","id":"${urls.actor('alice')}/follows/ACTID","type":"Follow","actor":"${urls.actor('alice')}","object":"${remote}"}`,
    );
  });

  it('short-circuits when federation is disabled', async () => {
    const rig = makeRig({ federationEnabled: false });
    const result = await rig.service.sendFollow('u-alice', 'alice', 'https://remote.example/users/bob');
    expect(result).toEqual({ success: false, pending: false });
    expect(rig.deliveredBodies).toHaveLength(0);
    expect(rig.upsertedFollows).toHaveLength(0);
  });

  it('refuses to deliver Follow to a blocked origin even when the inbox is cached', async () => {
    const remote = 'https://blocked.example/users/bob';
    const rig = makeRig({
      blockedHosts: ['blocked.example'],
      actorsByUri: {
        [remote]: { _id: 'ACTID', uri: remote, inboxUrl: 'https://blocked.example/inbox' },
      },
    });

    const result = await rig.service.sendFollow('u-alice', 'alice', remote);
    await flush();

    expect(result).toEqual({ success: false, pending: false });
    expect(rig.upsertedFollows).toHaveLength(0);
    expect(rig.deliveredBodies).toHaveLength(0);
    expect(rig.enqueued).toHaveLength(0);
  });
});

describe('sendAccept', () => {
  it('delivers the exact Accept(Follow) activity with the full AP_CONTEXT', async () => {
    const remote = 'https://remote.example/users/bob';
    const rig = makeRig({
      actorsByUri: { [remote]: { _id: 'A', uri: remote, inboxUrl: 'https://remote.example/inbox' } },
    });

    await rig.service.sendAccept('u-alice', 'alice', 'https://remote.example/follows/1', remote);

    expect(rig.deliveredBodies).toHaveLength(1);
    const activity = JSON.parse(rig.deliveredBodies[0].body);
    expect(activity).toEqual({
      '@context': AP_CONTEXT,
      id: `${urls.actor('alice')}/accepts/${Date.now()}`,
      type: 'Accept',
      actor: urls.actor('alice'),
      object: {
        id: 'https://remote.example/follows/1',
        type: 'Follow',
        actor: remote,
        object: urls.actor('alice'),
      },
    });
  });

  it('is a no-op when the target actor has no inbox', async () => {
    const remote = 'https://remote.example/users/bob';
    const rig = makeRig({ actorsByUri: { [remote]: { _id: 'A', uri: remote } } });
    await rig.service.sendAccept('u-alice', 'alice', 'f1', remote);
    expect(rig.deliveredBodies).toHaveLength(0);
    expect(rig.enqueued).toHaveLength(0);
  });

  it('delivers Accept to sharedInboxUrl when inboxUrl is absent', async () => {
    const remote = 'https://remote.example/users/bob';
    const rig = makeRig({
      actorsByUri: {
        [remote]: {
          _id: 'A',
          uri: remote,
          sharedInboxUrl: 'https://remote.example/shared-inbox',
        },
      },
    });

    await rig.service.sendAccept('u-alice', 'alice', 'https://remote.example/follows/1', remote);

    expect(rig.deliveredBodies).toHaveLength(1);
    expect(rig.deliveredBodies[0].url).toBe('https://remote.example/shared-inbox');
  });

  it('skips Accept delivery to a blocked origin', async () => {
    const remote = 'https://blocked.example/users/bob';
    const rig = makeRig({
      blockedHosts: ['blocked.example'],
      actorsByUri: { [remote]: { _id: 'A', uri: remote, inboxUrl: 'https://blocked.example/inbox' } },
    });

    await rig.service.sendAccept('u-alice', 'alice', 'https://blocked.example/follows/1', remote);

    expect(rig.deliveredBodies).toHaveLength(0);
    expect(rig.enqueued).toHaveLength(0);
  });
});

describe('sendUndoFollow', () => {
  it('deletes the local follow, then delivers the exact Undo(Follow) with AP_CONTEXT', async () => {
    const remote = 'https://remote.example/users/bob';
    const rig = makeRig({
      actorsByUri: { [remote]: { _id: 'A', uri: remote, inboxUrl: 'https://remote.example/inbox' } },
    });

    const ok = await rig.service.sendUndoFollow('u-alice', 'alice', remote);
    await flush();

    expect(ok).toBe(true);
    expect(rig.deletedFollowIds).toEqual(['A']);
    expect(rig.deliveredBodies).toHaveLength(1);
    const activity = JSON.parse(rig.deliveredBodies[0].body);
    expect(activity).toEqual({
      '@context': AP_CONTEXT,
      id: `${urls.actor('alice')}/follows/A/undo`,
      type: 'Undo',
      actor: urls.actor('alice'),
      object: {
        id: `${urls.actor('alice')}/follows/A`,
        type: 'Follow',
        actor: urls.actor('alice'),
        object: remote,
      },
    });
  });

  it('removes the local follow but skips Undo delivery to a blocked origin', async () => {
    const remote = 'https://blocked.example/users/bob';
    const rig = makeRig({
      blockedHosts: ['blocked.example'],
      actorsByUri: { [remote]: { _id: 'A', uri: remote, inboxUrl: 'https://blocked.example/inbox' } },
    });

    const ok = await rig.service.sendUndoFollow('u-alice', 'alice', remote);
    await flush();

    expect(ok).toBe(true);
    expect(rig.deletedFollowIds).toEqual(['A']);
    expect(rig.deliveredBodies).toHaveLength(0);
    expect(rig.enqueued).toHaveLength(0);
  });
});

describe('deliverToFollowers', () => {
  it('dedupes by shared inbox across followers + extraInboxes', async () => {
    const shared = 'https://shared.example/inbox';
    const rig = makeRig({
      followerActorUris: ['a', 'b', 'c'],
      followerInboxes: {
        a: { sharedInboxUrl: shared },
        b: { sharedInboxUrl: shared }, // same shared inbox → deduped
        c: { inboxUrl: 'https://c.example/inbox' },
      },
    });

    await rig.service.deliverToFollowers({ id: 'act1', type: 'Create' }, 'u-alice', 'alice', {
      // The first coincides with a follower's shared inbox (deduped); the second is new.
      extraInboxes: [shared, 'https://parent.example/inbox'],
    });

    expect(rig.enqueued.map((j) => j.targetInbox)).toEqual([
      shared,
      'https://c.example/inbox',
      'https://parent.example/inbox',
    ]);
    expect(rig.fallbackInserts).toHaveLength(0);
  });

  it('falls back to the durable queue when BullMQ is unavailable', async () => {
    const rig = makeRig({
      enqueueReturns: false,
      followerActorUris: ['a'],
      followerInboxes: { a: { inboxUrl: 'https://a.example/inbox' } },
    });

    await rig.service.deliverToFollowers({ id: 'act1', type: 'Create' }, 'u-alice', 'alice');

    expect(rig.fallbackInserts.map((j) => j.targetInbox)).toEqual(['https://a.example/inbox']);
  });

  it('does nothing when there are no inboxes', async () => {
    const rig = makeRig({ followerActorUris: [] });
    await rig.service.deliverToFollowers({ id: 'act1', type: 'Create' }, 'u-alice', 'alice');
    expect(rig.enqueued).toHaveLength(0);
    expect(rig.fallbackInserts).toHaveLength(0);
  });

  it('skips unsafe inbox URLs instead of enqueueing or falling back', async () => {
    const unsafeGuard = jest.fn(async (url: string) =>
      url.includes('unsafe')
        ? { ok: false as const, reason: 'blocked' }
        : { ok: true as const },
    );
    const rig = makeRig({
      followerActorUris: ['a', 'b'],
      followerInboxes: {
        a: { inboxUrl: 'https://unsafe.example/inbox' },
        b: { inboxUrl: 'https://safe.example/inbox' },
      },
      enqueueReturns: false,
      assertSafeInboxUrl: unsafeGuard,
    });

    await rig.service.deliverToFollowers({ id: 'act1', type: 'Create' }, 'u-alice', 'alice');

    expect(unsafeGuard).toHaveBeenCalledTimes(2);
    expect(rig.enqueued.map((j) => j.targetInbox)).toEqual(['https://safe.example/inbox']);
    expect(rig.fallbackInserts.map((j) => j.targetInbox)).toEqual(['https://safe.example/inbox']);
  });

  it('skips follower fan-out to blocked inboxes', async () => {
    const rig = makeRig({
      blockedHosts: ['blocked.example'],
      followerActorUris: ['a', 'b'],
      followerInboxes: {
        a: { inboxUrl: 'https://blocked.example/inbox' },
        b: { inboxUrl: 'https://safe.example/inbox' },
      },
    });

    await rig.service.deliverToFollowers({ id: 'act1', type: 'Create' }, 'u-alice', 'alice');

    expect(rig.enqueued.map((j) => j.targetInbox)).toEqual(['https://safe.example/inbox']);
  });
});

describe('federateActorUpdate', () => {
  it('rebroadcasts the actor as an Update(Person) with AP_CONTEXT to followers', async () => {
    const shared = 'https://shared.example/inbox';
    const rig = makeRig({
      followerActorUris: ['a'],
      followerInboxes: { a: { sharedInboxUrl: shared } },
    });

    await rig.service.federateActorUpdate('u-alice', 'alice');

    expect(rig.enqueued).toHaveLength(1);
    const activity = rig.enqueued[0].activityJson as Record<string, unknown>;
    expect(activity['@context']).toEqual(AP_CONTEXT);
    expect(activity.type).toBe('Update');
    expect(activity.actor).toBe(urls.actor('alice'));
    expect(activity.id).toBe(`${urls.actor('alice')}#updates/${Date.now()}`);
    expect(activity.to).toEqual(['https://www.w3.org/ns/activitystreams#Public']);
    expect(activity.cc).toEqual([`${urls.actor('alice')}/followers`]);
    expect(activity.object).toEqual({ id: urls.actor('alice'), type: 'Person', name: 'Alice' });
  });

  it('is gated on the sharing-consent flag', async () => {
    const rig = makeRig({ sharingEnabled: false, followerActorUris: ['a'] });
    await rig.service.federateActorUpdate('u-alice', 'alice');
    expect(rig.enqueued).toHaveLength(0);
  });
});
