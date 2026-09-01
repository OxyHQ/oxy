import { ACCOUNT_KINDS } from '@oxyhq/contracts';
import {
  AP_CONTEXT,
  createLocalActorBuilder,
  createUrlBuilders,
  AP_ACTOR_TYPES,
  isApActorType,
  LOCAL_ACTOR_TYPE_BY_ACCOUNT_KIND,
  localActorTypeForAccountKind,
  type ActorMediaResolver,
} from '../index';

/**
 * GOLDEN VECTOR — the exact `Person` actor document the engine emits.
 *
 * The bytes of this document are load-bearing: Mastodon negative-caches a
 * malformed actor for minutes/hours, so ANY drift in the field set, key ORDER,
 * `@context` terms, URL shapes, or the `publicKey` (id host == actor host) can
 * silently kill discovery ecosystem-wide. This vector is byte-frozen against the
 * proven live `/ap/users/nate` actor shape; a change here that is not intentional
 * is a federation break, not a test to "fix".
 */

/** A media resolver that returns fixed absolute CDN URLs (avatar png, banner jpg). */
const media: ActorMediaResolver = {
  resolveAvatar: (ref) => (ref === 'avatar-file-id' ? 'https://cloud.oxy.so/media/nate-avatar.png' : undefined),
  resolveBanner: (ref) => (ref === 'banner-file-id' ? 'https://cloud.oxy.so/media/nate-banner.jpg' : undefined),
};

const buildActor = createLocalActorBuilder({
  domain: 'mention.earth',
  urls: createUrlBuilders('mention.earth'),
  media,
});

const PUBLIC_KEY_PEM =
  '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA\n-----END PUBLIC KEY-----\n';

const PARAMS = {
  username: 'nate',
  displayName: 'Nate',
  bio: 'building the fediverse',
  avatar: 'avatar-file-id',
  profileHeaderImage: 'banner-file-id',
  publicKey: {
    keyId: 'https://mention.earth/ap/users/nate#main-key',
    publicKeyPem: PUBLIC_KEY_PEM,
  },
  createdAt: '2023-01-15T10:30:00.000Z',
} as const;

/**
 * The frozen expected actor, in the EXACT key order the builder emits. `toEqual`
 * checks values; the `JSON.stringify` string check locks the serialization order.
 */
const EXPECTED_ACTOR: Record<string, unknown> = {
  id: 'https://mention.earth/ap/users/nate',
  type: 'Person',
  preferredUsername: 'nate',
  name: 'Nate',
  summary: 'building the fediverse',
  url: 'https://mention.earth/@nate',
  inbox: 'https://mention.earth/ap/users/nate/inbox',
  outbox: 'https://mention.earth/ap/users/nate/outbox',
  featured: 'https://mention.earth/ap/users/nate/collections/featured',
  followers: 'https://mention.earth/ap/users/nate/followers',
  following: 'https://mention.earth/ap/users/nate/following',
  endpoints: { sharedInbox: 'https://mention.earth/ap/inbox' },
  discoverable: true,
  manuallyApprovesFollowers: false,
  icon: { type: 'Image', url: 'https://cloud.oxy.so/media/nate-avatar.png', mediaType: 'image/png' },
  image: { type: 'Image', url: 'https://cloud.oxy.so/media/nate-banner.jpg', mediaType: 'image/jpeg' },
  publicKey: {
    id: 'https://mention.earth/ap/users/nate#main-key',
    owner: 'https://mention.earth/ap/users/nate',
    publicKeyPem: PUBLIC_KEY_PEM,
  },
  published: '2023-01-15T10:30:00.000Z',
};

describe('createLocalActorBuilder (golden actor vector)', () => {
  it('emits the byte-identical Person actor for a fixed user', () => {
    const actor = buildActor(PARAMS);
    expect(actor).toEqual(EXPECTED_ACTOR);
    // Byte-identity: the serialized bytes (key order included) must match exactly.
    expect(JSON.stringify(actor)).toBe(JSON.stringify(EXPECTED_ACTOR));
  });

  it('serves the byte-identical document once wrapped in the route @context', () => {
    const served = { '@context': AP_CONTEXT, ...buildActor(PARAMS) };
    expect(JSON.stringify(served)).toBe(JSON.stringify({ '@context': AP_CONTEXT, ...EXPECTED_ACTOR }));
    // publicKey.id host MUST equal the actor id host (Mastodon rejects a cross-domain key).
    const key = served.publicKey as { id: string };
    expect(new URL(key.id).host).toBe(new URL(served.id as string).host);
  });

  it('pins the load-bearing @context term declarations', () => {
    expect(AP_CONTEXT[0]).toBe('https://www.w3.org/ns/activitystreams');
    expect(AP_CONTEXT[1]).toBe('https://w3id.org/security/v1');
    expect(AP_CONTEXT[2]).toMatchObject({
      sensitive: 'as:sensitive',
      toot: 'http://joinmastodon.org/ns#',
      votersCount: 'toot:votersCount',
      quote: { '@id': 'https://w3id.org/fep/044f#quote', '@type': '@id' },
    });
  });

  it('omits icon/image (but keeps the account valid) when media does not resolve to an absolute URL', () => {
    const warnings: string[] = [];
    const strictBuilder = createLocalActorBuilder({
      domain: 'mention.earth',
      urls: createUrlBuilders('mention.earth'),
      media: { resolveAvatar: () => undefined, resolveBanner: () => 'not-an-absolute-url' },
      onWarn: (m) => warnings.push(m),
    });
    const actor = strictBuilder({ ...PARAMS, avatar: null, profileHeaderImage: 'y' });
    expect(actor.icon).toBeUndefined();
    expect(actor.image).toBeUndefined();
    // A non-absolute banner is warned; an absent avatar is not (nothing to resolve).
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Omitting actor image');
    expect(JSON.stringify(actor)).not.toContain('"icon"');
    expect(JSON.stringify(actor)).not.toContain('"image"');
  });
});

/**
 * The RECOGNITION vocabulary, which is a different question from what we emit:
 * an inbound `Update` carrying a profile is dispatched on it, so a type missing
 * here means that class of account's profile edits are applied to NOTHING, with
 * no error raised anywhere.
 *
 * `Group` and `Organization` are the two that matter and the two most likely to
 * be "tidied" out, since this engine never emits `Group` at all: a Lemmy
 * community IS a `Group`, and a Mention channel is now an `Organization`.
 */
describe('AS2 actor recognition vocabulary', () => {
  it('recognizes all five AS2 actor types', () => {
    expect([...AP_ACTOR_TYPES].sort()).toEqual([
      'Application',
      'Group',
      'Organization',
      'Person',
      'Service',
    ]);
    for (const type of AP_ACTOR_TYPES) {
      expect(isApActorType(type)).toBe(true);
    }
  });

  it('separates actors from the content objects sharing the dispatch', () => {
    // The inbound Update handler is `if (Note|Article) … else if (isApActorType)`,
    // so a predicate that answered true for content would route an edited post
    // into an actor refetch.
    expect(isApActorType('Note')).toBe(false);
    expect(isApActorType('Article')).toBe(false);
    expect(isApActorType(undefined)).toBe(false);
    expect(isApActorType('person')).toBe(false);
  });

  it('covers every type the emitted subset draws from', () => {
    for (const emitted of Object.values(LOCAL_ACTOR_TYPE_BY_ACCOUNT_KIND)) {
      expect(isApActorType(emitted)).toBe(true);
    }
  });
});

/**
 * The actor `type` is the ONE field that varies by account kind, and it is a
 * public claim about what an account IS — a `Person` is a human being. These
 * assertions are written so that a mapping which collapsed to a single constant
 * (the easiest way to break this by accident) cannot pass:
 *
 *  - the per-kind table names BOTH sides of every branch, so a fixture set made
 *    only of channels could not tell "channels are Service" from "everything is
 *    Service";
 *  - the coverage assertion is driven by contracts' own `ACCOUNT_KINDS`, so a
 *    kind added upstream fails here rather than silently inheriting `Person`;
 *  - the distinct-value floor fails any constant mapping outright.
 */
describe('actor type by Oxy account kind', () => {
  it('maps each kind to the AS2 type announced for it', () => {
    expect(localActorTypeForAccountKind('personal')).toBe('Person');
    expect(localActorTypeForAccountKind('organization')).toBe('Organization');
    expect(localActorTypeForAccountKind('project')).toBe('Organization');
    expect(localActorTypeForAccountKind('bot')).toBe('Service');
    expect(localActorTypeForAccountKind('channel')).toBe('Organization');
  });

  it('never announces a human-curated channel as automated', () => {
    // `Service` is what Mastodon writes for "this is an automated account"
    // (account.rb:224) and is half of `bot?` (account.rb:90) — the Automated
    // badge, the SimilarProfilesSource exclusion and Lemmy's `bot_account`.
    // A channel is curated by people; only `bot` may claim automation.
    expect(localActorTypeForAccountKind('channel')).not.toBe('Service');
    expect(localActorTypeForAccountKind('bot')).toBe('Service');
    // `Group` is never emitted for anything: Lemmy would reclassify the actor as
    // a community that silently never receives content, and PeerTube rejects a
    // `Group` lacking `attributedTo` outright.
    expect(Object.values(LOCAL_ACTOR_TYPE_BY_ACCOUNT_KIND)).not.toContain('Group');
  });

  it('covers every account kind contracts defines, with more than one answer', () => {
    // Coverage: driven by the upstream vocabulary, so a new kind fails here.
    expect(Object.keys(LOCAL_ACTOR_TYPE_BY_ACCOUNT_KIND).sort()).toEqual([...ACCOUNT_KINDS].sort());
    // Vacuity floor: a mapping that returned one constant would pass every
    // single-kind assertion above and fail this.
    const answers = ACCOUNT_KINDS.map((kind) => localActorTypeForAccountKind(kind));
    expect(new Set(answers).size).toBe(3);
    // And specifically: the two kinds either side of the channel decision differ.
    expect(localActorTypeForAccountKind('channel')).not.toBe(
      localActorTypeForAccountKind('personal'),
    );
  });

  it('falls back to Person for an absent, null, or unrecognized kind', () => {
    expect(localActorTypeForAccountKind(undefined)).toBe('Person');
    expect(localActorTypeForAccountKind(null)).toBe('Person');
    // Version skew: an Oxy API that knows a kind this package does not must not
    // produce `type: undefined` — a malformed actor Mastodon negative-caches.
    expect(localActorTypeForAccountKind('venue')).toBe('Person');
    expect(localActorTypeForAccountKind(7)).toBe('Person');
  });

  it('emits the kind-derived type from the builder, keeping key order frozen', () => {
    // A channel: NOT a person, and the whole point of the change.
    const channel = buildActor({ ...PARAMS, kind: 'channel' });
    expect(channel.type).toBe('Organization');
    // The other side of the branch — without this the assertion above would hold
    // just as well for a builder that hardcoded 'Organization'.
    const personal = buildActor({ ...PARAMS, kind: 'personal' });
    expect(personal.type).toBe('Person');
    expect(buildActor({ ...PARAMS, kind: 'bot' }).type).toBe('Service');

    // `type` is field 2 of the byte-frozen document: only its VALUE may vary.
    expect(Object.keys(channel)).toEqual(Object.keys(EXPECTED_ACTOR));
    expect(Object.keys(channel)[1]).toBe('type');
    expect(JSON.stringify(channel)).toBe(
      JSON.stringify({ ...EXPECTED_ACTOR, type: 'Organization' }),
    );
  });

  it('leaves an actor with no kind byte-identical to the pre-change document', () => {
    // The golden vector's PARAMS carries no `kind` — the regression guard that
    // this change is inert for every ordinary account already federated.
    expect(buildActor(PARAMS).type).toBe('Person');
    expect(JSON.stringify(buildActor(PARAMS))).toBe(JSON.stringify(EXPECTED_ACTOR));
  });
});

describe('createUrlBuilders', () => {
  it('scopes actor() to actorDomain and the rest to domain', () => {
    const urls = createUrlBuilders('mention.earth', 'actors.mention.earth');
    expect(urls.actor('nate')).toBe('https://actors.mention.earth/ap/users/nate');
    expect(urls.inbox('nate')).toBe('https://mention.earth/ap/users/nate/inbox');
    expect(urls.sharedInbox()).toBe('https://mention.earth/ap/inbox');
  });
});
