import crypto from 'node:crypto';
import express, { type Express } from 'express';
import request from 'supertest';
import { createDomainPolicy } from '../apUri';
import { createInboundDispatcher } from '../node/inboundDispatch';
import { createWebfingerRouter, type WebfingerRouterConfig } from '../node/webfingerRouter';
import { createActorRouter, type ActorRouterConfig } from '../node/actorRouter';
import { createUrlBuilders } from '../urls';
import { signRequest, type HttpSignatureSigner } from '../httpSignature';

/**
 * Phase 4b router proof (mount-order tripwire + consent gate + inbox verify).
 *
 * The AP endpoint paths MUST serve 200 DIRECTLY — a 301/302 kills Mastodon's
 * inbox POST deliveries — so this asserts the actor GET + inbox POST resolve
 * without a redirect, that the fediverse-sharing gate 404s an OFF/unknown user
 * indistinguishably, and that a validly-signed inbox POST returns 202 and reaches
 * the dispatcher (proving the HTTP-signature verify wiring end to end).
 */

const DOMAIN = 'mention.earth';
const urls = createUrlBuilders(DOMAIN);

// A fixed throwaway RSA keypair for the inbox signature round-trip.
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const REMOTE_ACTOR = 'https://remote.example/users/bob';
const REMOTE_KEY_ID = `${REMOTE_ACTOR}#main-key`;
const REMOTE_PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();

const sign: HttpSignatureSigner = async (_keyId, signingString) => {
  const s = crypto.createSign('sha256');
  s.update(signingString);
  s.end();
  return s.sign(privateKey, 'base64');
};

function wantsActivityPub(accept: string | string[] | undefined): boolean {
  if (!accept) return false;
  const value = Array.isArray(accept) ? accept.join(',') : accept;
  const lower = value.toLowerCase();
  return lower.includes('activity+json') || lower.includes('ld+json');
}

function makeWebfingerApp(overrides: Partial<WebfingerRouterConfig> = {}): Express {
  const app = express();
  const router = createWebfingerRouter({
    domain: DOMAIN,
    federationEnabled: true,
    urls,
    resolveUser: async (username) => (username === 'alice' ? { _id: 'u-alice' } : null),
    consent: {
      isSharingEnabledFromUser: () => true,
      getSharingStateByUsername: async (username) => (username === 'alice' ? 'enabled' : 'unknown-user'),
    },
    cache: { get: async () => null, set: () => {} },
    logger: { error: () => {} },
    ...overrides,
  });
  app.use('/.well-known', router);
  return app;
}

function makeActorApp(overrides: {
  actorConfig?: Partial<ActorRouterConfig>;
  onDispatch?: (activity: Record<string, unknown>, verifiedActorUri: string) => void;
} = {}): Express {
  const app = express();
  app.use(
    express.json({
      type: () => true,
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: string }).rawBody = buf.toString('utf8');
      },
    }),
  );

  const config: ActorRouterConfig = {
    domain: DOMAIN,
    federationEnabled: true,
    apContentType: 'application/activity+json',
    urls,
    wantsActivityPub,
    getPublicKey: async () => ({ keyId: `${urls.actor('alice')}#main-key`, publicKeyPem: 'LOCALPEM' }),
    resolveUser: async (username) => (username === 'alice' ? { _id: 'u-alice', name: { displayName: 'Alice' }, _count: { followers: 3, following: 1 } } : null),
    consent: {
      isSharingEnabledFromUser: () => true,
      getSharingStateByUsername: async (username) => (username === 'alice' ? 'enabled' : 'unknown-user'),
    },
    buildLocalActorObject: (params) => ({ id: urls.actor(params.username), type: 'Person', name: params.displayName }),
    getBanner: async () => null,
    inbound: {
      fetchPublicKey: async (keyId) =>
        keyId === REMOTE_KEY_ID ? { publicKeyPem: REMOTE_PUBLIC_PEM, actorUri: REMOTE_ACTOR } : null,
      trustForwardedHost: true,
      enqueueInboxActivity: async () => false, // force the inline dispatch path
      processInboxActivity: async (activity, verifiedActorUri) => {
        overrides.onDispatch?.(activity, verifiedActorUri);
      },
    },
    fetchFollowPage: async () => ({ members: [], total: 3, hasMore: false }),
    logger: { debug: () => {}, warn: () => {}, error: () => {} },
    ...overrides.actorConfig,
  };

  app.use('/ap', createActorRouter(config));
  return app;
}

describe('webfinger router', () => {
  it('resolves acct:alice@mention.earth to the actor self link (200)', async () => {
    const res = await request(makeWebfingerApp()).get('/.well-known/webfinger').query({ resource: 'acct:alice@mention.earth' });
    expect(res.status).toBe(200);
    expect(res.body.subject).toBe('acct:alice@mention.earth');
    expect(res.body.links[0]).toEqual({ rel: 'self', type: 'application/activity+json', href: urls.actor('alice') });
  });

  it('normalizes mixed-case acct local-parts before resolve', async () => {
    const resolveUser = jest.fn(async (username: string) => (username === 'alice' ? { _id: 'u-alice' } : null));
    const app = makeWebfingerApp({ resolveUser });
    const res = await request(app).get('/.well-known/webfinger').query({ resource: 'acct:Alice@mention.earth' });
    expect(res.status).toBe(200);
    expect(resolveUser).toHaveBeenCalledWith('alice');
    expect(res.body.subject).toBe('acct:alice@mention.earth');
  });

  it('404s an unknown domain', async () => {
    const res = await request(makeWebfingerApp()).get('/.well-known/webfinger').query({ resource: 'acct:alice@other.example' });
    expect(res.status).toBe(404);
  });

  it('accepts acct domain with www. prefix when config.domain is bare', async () => {
    const res = await request(makeWebfingerApp())
      .get('/.well-known/webfinger')
      .query({ resource: 'acct:alice@www.mention.earth' });
    expect(res.status).toBe(200);
    expect(res.body.links[0].href).toBe(urls.actor('alice'));
  });

  it('404s a sharing-disabled user indistinguishably', async () => {
    const app = makeWebfingerApp({
      consent: { isSharingEnabledFromUser: () => false, getSharingStateByUsername: async () => 'disabled' },
    });
    const res = await request(app).get('/.well-known/webfinger').query({ resource: 'acct:alice@mention.earth' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'User not found' });
  });

  it('serves host-meta with the LRDD template (200, no redirect)', async () => {
    const res = await request(makeWebfingerApp()).get('/.well-known/host-meta');
    expect(res.status).toBe(200);
    expect(res.text).toContain('https://mention.earth/.well-known/webfinger?resource={uri}');
  });
});

/**
 * The instance (server) actor MUST be WebFinger-resolvable, not merely servable
 * as an actor.
 *
 * Mastodon's `FetchRemoteKeyService#find_actor` calls `FetchRemoteActorService`
 * WITHOUT `only_key:`, and that service runs `check_webfinger!` unconditionally
 * — so a 404 here raises `Webfinger::Error`, yields a nil account, and every
 * secure-mode instance 401s EVERY signed GET we make (outbox sync, remote actor
 * fetch, quoted/boosted note import). Inbound delivery and outbound POST use the
 * USER key, whose WebFinger does loop back, which is why the outage is silent.
 */
describe('webfinger router — the instance (server) actor', () => {
  it('resolves acct:instance@mention.earth (200) — it is not an Oxy user', async () => {
    const res = await request(makeWebfingerApp())
      .get('/.well-known/webfinger')
      .query({ resource: 'acct:instance@mention.earth' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/jrd+json');
    expect(res.body.subject).toBe('acct:instance@mention.earth');
    expect(res.body.links).toContainEqual({
      rel: 'self',
      type: 'application/activity+json',
      href: urls.actor('instance'),
    });
  });

  it("self href EQUALS the actor route's advertised id — the thing Mastodon compares", async () => {
    // Both sides are read off REAL responses from the two routers, never rebuilt
    // here: two separately-constructed strings that happen to match today is
    // exactly the regression this asserts against.
    const webfinger = await request(makeWebfingerApp())
      .get('/.well-known/webfinger')
      .query({ resource: 'acct:instance@mention.earth' });
    const actor = await request(makeActorApp())
      .get('/ap/users/instance')
      .set('Accept', 'application/activity+json');

    expect(webfinger.status).toBe(200);
    expect(actor.status).toBe(200);

    const selfLink = webfinger.body.links.find(
      (link: { rel: string }) => link.rel === 'self',
    );
    expect(selfLink).toBeDefined();
    // Positive control: neither side may be vacuously undefined.
    expect(typeof actor.body.id).toBe('string');
    expect(actor.body.id.length).toBeGreaterThan(0);
    expect(selfLink.href).toBe(actor.body.id);
    // ...and the actor really is the server actor, not a Person that happened to match.
    expect(actor.body.type).toBe('Application');
  });

  it('bypasses resolveUser and the sharing-consent gate entirely', async () => {
    const resolveUser = jest.fn(async () => null);
    const getSharingStateByUsername = jest.fn(async () => 'unknown-user' as const);
    const app = makeWebfingerApp({
      resolveUser,
      consent: { isSharingEnabledFromUser: () => false, getSharingStateByUsername },
    });

    const res = await request(app)
      .get('/.well-known/webfinger')
      .query({ resource: 'acct:instance@mention.earth' });

    // Under the pre-fix code this is the live 404: resolveUser asks Oxy for a
    // user named `instance`, gets null, and the route 404s.
    expect(res.status).toBe(200);
    expect(resolveUser).not.toHaveBeenCalled();
    expect(getSharingStateByUsername).not.toHaveBeenCalled();
  });

  it('does not read or write the app JRD cache for the static instance document', async () => {
    const get = jest.fn(async () => null);
    const set = jest.fn(() => {});
    const res = await request(makeWebfingerApp({ cache: { get, set } }))
      .get('/.well-known/webfinger')
      .query({ resource: 'acct:instance@mention.earth' });

    expect(res.status).toBe(200);
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it.each([
    ['acct:instance@mention.earth', 'bare'],
    ['acct:Instance@mention.earth', 'mixed-case local-part'],
    ['acct:INSTANCE@mention.earth', 'upper-case local-part'],
    ['acct:  instance  @mention.earth', 'padded local-part'],
    ['acct:instance@www.mention.earth', 'www. host prefix'],
    ['acct:instance@MENTION.EARTH', 'upper-case host'],
  ])('accepts %s (%s) — every spelling the router already handles for users', async (resource) => {
    const res = await request(makeWebfingerApp()).get('/.well-known/webfinger').query({ resource });
    expect(res.status).toBe(200);
    expect(res.body.subject).toBe('acct:instance@mention.earth');
    expect(res.body.links[0].href).toBe(urls.actor('instance'));
  });

  it('still 404s the instance acct on a foreign domain', async () => {
    const res = await request(makeWebfingerApp())
      .get('/.well-known/webfinger')
      .query({ resource: 'acct:instance@other.example' });
    expect(res.status).toBe(404);
  });

  /**
   * The floor under every assertion above: an ORDINARY username this instance
   * cannot resolve still 404s, on the right domain, past every early return.
   *
   * Deliberately NOT redundant with the foreign-domain and sharing-disabled
   * cases, and measured rather than assumed. Those two exit BEFORE the resolve —
   * the first on the host compare, the second on a user that resolves and is
   * then gated — so neither one ever reaches `if (!user)`. Until this test
   * existed nothing in the suite did: replacing that 404 with a JRD naming
   * `urls.actor(username)` left all 210 tests green while the router advertised
   * an actor for every name anyone cared to ask about, which is a worse bug than
   * the one the instance branch was added to fix.
   *
   * It must stay INSENSITIVE to the instance branch (deleting the branch leaves
   * this green and turns ten neighbours red) — that asymmetry is what makes it a
   * control rather than another copy of them.
   */
  it('404s an ordinary unresolvable username — the instance branch is not blanket', async () => {
    const resolveUser = jest.fn(async () => null);
    const res = await request(makeWebfingerApp({ resolveUser }))
      .get('/.well-known/webfinger')
      .query({ resource: 'acct:ghost@mention.earth' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'User not found' });
    // Positive control: the request really did travel past the domain check and
    // the instance branch to the resolve. Without this, a router that 404'd for
    // some earlier reason would satisfy the assertions above and this test would
    // be measuring nothing.
    expect(resolveUser).toHaveBeenCalledWith('ghost');
  });

  it('404s the instance acct when federation is disabled', async () => {
    const res = await request(makeWebfingerApp({ federationEnabled: false }))
      .get('/.well-known/webfinger')
      .query({ resource: 'acct:instance@mention.earth' });
    expect(res.status).toBe(404);
  });
});

describe('actor router — GET /ap/users/:username', () => {
  it('serves the actor as 200 (NOT a redirect) for an AP Accept', async () => {
    const res = await request(makeActorApp())
      .get('/ap/users/alice')
      .set('Accept', 'application/activity+json');
    expect(res.status).toBe(200);
    expect(res.body['@context']).toBeDefined();
    expect(res.body.id).toBe(urls.actor('alice'));
    expect(res.body.name).toBe('Alice');
  });

  it('serves the instance actor as 200', async () => {
    const res = await request(makeActorApp())
      .get('/ap/users/instance')
      .set('Accept', 'application/activity+json');
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('Application');
    expect(res.body.id).toBe(urls.actor('instance'));
  });

  it('redirects a browser (non-AP Accept) to the profile — a GET-only 302', async () => {
    const res = await request(makeActorApp()).get('/ap/users/alice').set('Accept', 'text/html');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://mention.earth/@alice');
  });

  it('404s a sharing-disabled/unknown user', async () => {
    const res = await request(makeActorApp())
      .get('/ap/users/ghost')
      .set('Accept', 'application/activity+json');
    expect(res.status).toBe(404);
  });
});

describe('actor router — inbox POST', () => {
  /** Build a validly-signed inbox request body + headers for `activity`. */
  async function signedInbox(path: string, activity: Record<string, unknown>): Promise<{ body: string; headers: Record<string, string> }> {
    const body = JSON.stringify(activity);
    const headers = await signRequest(sign, REMOTE_KEY_ID, 'POST', `https://${DOMAIN}${path}`, body);
    return { body, headers };
  }

  it('accepts a validly-signed activity (202) and reaches the dispatcher — no redirect', async () => {
    const dispatched: Array<{ activity: Record<string, unknown>; verifiedActorUri: string }> = [];
    const app = makeActorApp({ onDispatch: (activity, verifiedActorUri) => dispatched.push({ activity, verifiedActorUri }) });

    const activity = { '@context': 'https://www.w3.org/ns/activitystreams', id: 'https://remote.example/f/1', type: 'Follow', actor: REMOTE_ACTOR, object: urls.actor('alice') };
    const { body, headers } = await signedInbox('/ap/inbox', activity);

    const res = await request(app)
      .post('/ap/inbox')
      .set('Content-Type', 'application/activity+json')
      // The apex is CF-proxied → ALB → backend; Mastodon signs over the apex host
      // and forwards it here (supertest's real Host is localhost).
      .set('X-Forwarded-Host', DOMAIN)
      .set(headers)
      .send(body);

    expect(res.status).toBe(202);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].verifiedActorUri).toBe(REMOTE_ACTOR);
    expect(dispatched[0].activity.type).toBe('Follow');
  });

  it('accepts a signed POST from a blocked origin (202) but the real dispatcher drops it', async () => {
    const domainPolicy = createDomainPolicy({ domain: DOMAIN, blockedDomains: ['remote.example'] });
    const contentActivities: Array<{ type: unknown; verifiedActorUri: string }> = [];
    const dispatcher = createInboundDispatcher({
      isBlockedDomain: domainPolicy.isBlockedDomain,
      validateActivity: (activity) => {
        const type = typeof activity.type === 'string' ? activity.type : undefined;
        return type ? { ok: true, type } : { ok: false, summary: 'no type' };
      },
      identity: {
        resolveUserByUsername: async () => ({ _id: 'u-alice' }),
        bridgeFollow: async () => {},
        bridgeUnfollow: async () => {},
      },
      consent: { isSharingEnabledFromUser: () => true },
      actorResolver: { getOrFetchActor: async () => ({ oxyUserId: 'u-bob' }) },
      follows: {
        upsertInboundAccepted: async () => {},
        findInboundFollow: async () => null,
        deleteFollowById: async () => {},
        findActorOxyUserId: async () => null,
        markOutboundAcceptedByActivityId: async () => true,
        markOutboundAcceptedAnyPending: async () => true,
        markOutboundRejected: async () => {},
      },
      delivery: { sendAccept: async () => {} },
      onInboundFollowAccepted: async () => {},
      onOutboundFollowAccepted: async () => {},
      onContentActivity: async (activity, verifiedActorUri) => {
        contentActivities.push({ type: activity.type, verifiedActorUri });
      },
      logger: { debug: () => {}, info: () => {}, warn: () => {} },
    });

    const app = makeActorApp({
      actorConfig: {
        inbound: {
          fetchPublicKey: async (keyId) =>
            keyId === REMOTE_KEY_ID ? { publicKeyPem: REMOTE_PUBLIC_PEM, actorUri: REMOTE_ACTOR } : null,
          trustForwardedHost: true,
          enqueueInboxActivity: async () => false,
          processInboxActivity: dispatcher.processInboxActivity,
        },
      },
    });

    const activity = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: 'https://remote.example/f/blocked',
      type: 'Create',
      actor: REMOTE_ACTOR,
      object: { type: 'Note', content: 'blocked' },
    };
    const { body, headers } = await signedInbox('/ap/inbox', activity);

    const res = await request(app)
      .post('/ap/inbox')
      .set('Content-Type', 'application/activity+json')
      .set('X-Forwarded-Host', DOMAIN)
      .set(headers)
      .send(body);

    expect(res.status).toBe(202);
    expect(contentActivities).toHaveLength(0);
  });

  it('rejects an unsigned inbox POST with 401', async () => {
    const res = await request(makeActorApp())
      .post('/ap/inbox')
      .set('Content-Type', 'application/activity+json')
      .send(JSON.stringify({ type: 'Follow', actor: REMOTE_ACTOR }));
    expect(res.status).toBe(401);
  });

  it('rejects an actor mismatch with 403', async () => {
    const activity = { id: 'https://remote.example/f/2', type: 'Follow', actor: 'https://evil.example/users/x', object: urls.actor('alice') };
    const { body, headers } = await signedInbox('/ap/inbox', activity);
    const res = await request(makeActorApp())
      .post('/ap/inbox')
      .set('Content-Type', 'application/activity+json')
      .set('X-Forwarded-Host', DOMAIN)
      .set(headers)
      .send(body);
    expect(res.status).toBe(403);
  });

  it('404s a user inbox for a sharing-disabled user (before signature verify)', async () => {
    const activity = { id: 'https://remote.example/f/3', type: 'Follow', actor: REMOTE_ACTOR, object: urls.actor('ghost') };
    const { body, headers } = await signedInbox('/ap/users/ghost/inbox', activity);
    const res = await request(makeActorApp())
      .post('/ap/users/ghost/inbox')
      .set('Content-Type', 'application/activity+json')
      .set(headers)
      .send(body);
    expect(res.status).toBe(404);
  });
});
