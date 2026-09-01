/**
 * The network-identity MECHANISM. No bridge entries live in this package, so
 * these drive the machinery with entries defined here in the test — which is
 * also the point: an app supplies its own, and the mechanism must behave the
 * same whatever they are.
 *
 * The entries an app actually ships, and the fixtures pinning their derivation
 * rules against real actors, are tested beside those entries.
 */

import {
  FEDERATION_NETWORKS,
  blueskyUsernameFromHandle,
  createBridgeRelabeller,
  parseUpstreamProfileUrl,
  federatedUsernameFromUpstreamUrl,
  stripBridgeBoilerplate,
  upstreamHandleFromAutomatedActor,
  upstreamHandleFromPreferredUsername,
  upstreamHandleFromProfileField,
  upstreamHandleFromProxyOf,
  readProxyDeclarations,
  upstreamHandleFromAlsoKnownAs,
  upstreamProfileUrl,
  type FederationBridgeEntry,
  type NetworkIdentityCandidate,
} from '../networkIdentity';

function entry(overrides: Partial<FederationBridgeEntry> = {}): FederationBridgeEntry {
  return {
    host: 'mirror.example',
    network: FEDERATION_NETWORKS.x,
    operator: 'Test operator',
    software: 'TestBridge',
    derive: upstreamHandleFromProfileField({ fieldName: 'Official', hosts: ['twitter.com', 'x.com'] }),
    caseRule: 'lowercase',
    relabel: 'enabled',
    upstreamIdStability: 'recyclable',
    boilerplate: [/\s*Mirrored by mirror\.example\.\s*$/],
    consent: 'unconsented',
    evidence: 'test',
    assumption: '',
    since: '2026-08-02',
    ...overrides,
  };
}

function candidate(overrides: Partial<NetworkIdentityCandidate> = {}): NetworkIdentityCandidate {
  return {
    host: 'mirror.example',
    acct: 'wired@mirror.example',
    preferredUsername: 'WIRED',
    actorUri: 'https://mirror.example/users/WIRED',
    actorType: 'Service',
    alsoKnownAs: [],
    fields: [{ name: 'Official', value: '<a href="https://twitter.com/WIRED" rel="me">x</a>' }],
    proxyOf: [],
    bio: 'The latest in tech.\nMirrored by mirror.example.',
    ...overrides,
  };
}

describe('createBridgeRelabeller', () => {
  it('re-labels an actor onto the network its bridge mirrors', () => {
    const identity = createBridgeRelabeller([entry()]).deriveNetworkIdentity(candidate());
    expect(identity?.federatedUsername).toBe('wired@x.com');
    expect(identity?.instanceDomain).toBe('x.com');
    expect(identity?.bio).toBe('The latest in tech.');
  });

  it('declines an actor from a host no entry names', () => {
    const relabeller = createBridgeRelabeller([entry()]);
    expect(relabeller.deriveNetworkIdentity(candidate({ host: 'mastodon.social' }))).toBeUndefined();
  });

  it('ships no entries of its own — an empty registry re-labels nothing', () => {
    expect(createBridgeRelabeller([]).deriveNetworkIdentity(candidate())).toBeUndefined();
  });

  it('preserves case where the entry says the handle is already canonical', () => {
    const identity = createBridgeRelabeller([entry({ caseRule: 'preserve' })])
      .deriveNetworkIdentity(candidate());
    expect(identity?.federatedUsername).toBe('WIRED@x.com');
  });
});

describe('createBridgeRelabeller — the pending_dedup gate', () => {
  /**
   * Re-labelling MANUFACTURES duplicates: two bridges of one network that render
   * as visibly different accounts today both render the same handle afterwards.
   * A `pending_dedup` entry is committed and reviewed but must stay inert.
   */
  it('does not re-label an entry that is pending de-duplication', () => {
    const relabeller = createBridgeRelabeller([entry({ relabel: 'pending_dedup' })]);
    expect(relabeller.deriveNetworkIdentity(candidate())).toBeUndefined();
  });

  it('still finds and vouches for a pending entry, so the trust question is separable', () => {
    const relabeller = createBridgeRelabeller([entry({ relabel: 'pending_dedup' })]);
    expect(relabeller.findBridge('mirror.example')?.relabel).toBe('pending_dedup');
    expect(relabeller.vouchesForNetwork('mirror.example', 'x.com')).toBe(true);
  });
});

describe('createBridgeRelabeller — derivations it refuses', () => {
  /**
   * An empty handle is the signature of a BROKEN rule, not an unusual account,
   * and it is the most destructive outcome available: every actor on the domain
   * would collapse onto one identity. We hold federated actors with no
   * `preferredUsername` at all, so this is reachable rather than theoretical.
   */
  it.each([
    ['an empty string', ''],
    ['whitespace only', '   '],
  ])('refuses a rule that yields %s, rather than collapsing a domain onto one identity', (_label, derived) => {
    // Asserted against the relabeller's OWN guard, with a rule that returns the
    // bad value directly. Driving it through `upstreamHandleFromPreferredUsername`
    // would prove nothing: that helper filters empties itself, so the outer guard
    // is never reached and the assertion passes with the guard deleted.
    const relabeller = createBridgeRelabeller([entry({ derive: () => derived })]);
    expect(relabeller.deriveNetworkIdentity(candidate())).toBeUndefined();
  });

  it('refuses an empty preferredUsername, which we hold real actors with', () => {
    const relabeller = createBridgeRelabeller([
      entry({ derive: upstreamHandleFromPreferredUsername([/./]) }),
    ]);
    expect(relabeller.deriveNetworkIdentity(candidate({ preferredUsername: '' }))).toBeUndefined();
    expect(relabeller.deriveNetworkIdentity(candidate({ preferredUsername: '   ' }))).toBeUndefined();
  });

  it('refuses a handle carrying an at-sign or a slash', () => {
    const relabeller = createBridgeRelabeller([
      entry({ derive: upstreamHandleFromPreferredUsername([/./]) }),
    ]);
    expect(relabeller.deriveNetworkIdentity(candidate({ preferredUsername: 'a@b' }))).toBeUndefined();
    expect(relabeller.deriveNetworkIdentity(candidate({ preferredUsername: 'a/b' }))).toBeUndefined();
  });

  it('derives nothing when the backlink points off the declared network', () => {
    const relabeller = createBridgeRelabeller([entry()]);
    expect(relabeller.deriveNetworkIdentity(candidate({
      fields: [{ name: 'Official', value: '<a href="https://example.com/wired">x</a>' }],
    }))).toBeUndefined();
  });

  it('derives nothing from a link that is not a bare profile path', () => {
    const relabeller = createBridgeRelabeller([entry()]);
    expect(relabeller.deriveNetworkIdentity(candidate({
      fields: [{ name: 'Official', value: '<a href="https://twitter.com/i/status/1">x</a>' }],
    }))).toBeUndefined();
  });

  it('matches profile hosts canonically, so a www. prefix on either side still round-trips', () => {
    const relabeller = createBridgeRelabeller([
      entry({ derive: upstreamHandleFromProfileField({ fieldName: 'Official', hosts: ['www.twitter.com'] }) }),
    ]);
    expect(relabeller.deriveNetworkIdentity(candidate({
      fields: [{ name: 'Official', value: '<a href="https://twitter.com/WIRED" rel="me">x</a>' }],
    proxyOf: [],
    }))?.federatedUsername).toBe('wired@x.com');
    expect(relabeller.deriveNetworkIdentity(candidate({
      fields: [{ name: 'Official', value: '<a href="https://www.twitter.com/WIRED" rel="me">x</a>' }],
    }))?.federatedUsername).toBe('wired@x.com');
  });

  it('derives a Bluesky handle from alsoKnownAs profile URLs (Bridgy Fed pattern)', () => {
    const relabeller = createBridgeRelabeller([
      entry({
        host: 'bsky.brid.gy',
        network: FEDERATION_NETWORKS.bluesky,
        derive: (c) => {
          const raw = upstreamHandleFromAlsoKnownAs({
            hosts: ['bsky.app'],
            pathPrefix: ['profile'],
          })(c);
          return raw === undefined ? undefined : blueskyUsernameFromHandle(raw);
        },
      }),
    ]);
    expect(relabeller.deriveNetworkIdentity(candidate({
      host: 'bsky.brid.gy',
      acct: 'jay.bsky.team@bsky.brid.gy',
      preferredUsername: 'jay.bsky.team',
      alsoKnownAs: [
        'at://did:plc:abc123',
        'https://bsky.app/profile/jay.bsky.team',
      ],
      fields: [],
      bio: '',
    }))?.federatedUsername).toBe('jay.bsky.team@bsky.social');
  });

  it('requires the marker before trusting a naming convention', () => {
    // The bridge operator's own account lives on the same host and is not a
    // mirror of anything; relabelling it would invent an upstream person.
    const relabeller = createBridgeRelabeller([
      entry({ derive: upstreamHandleFromPreferredUsername([/is a mirror bot\.$/]) }),
    ]);
    expect(relabeller.deriveNetworkIdentity(candidate({ bio: 'I run this server.' }))).toBeUndefined();
    expect(relabeller.deriveNetworkIdentity(candidate({ bio: 'is a mirror bot.' }))?.federatedUsername)
      .toBe('wired@x.com');
  });
});

describe('createBridgeRelabeller — the trust predicate a resolver asks', () => {
  it('lets a bridge vouch only for the network it mirrors', () => {
    const relabeller = createBridgeRelabeller([entry()]);
    expect(relabeller.vouchesForNetwork('mirror.example', 'x.com')).toBe(true);
    expect(relabeller.vouchesForNetwork('mirror.example', 'instagram.com')).toBe(false);
    expect(relabeller.vouchesForNetwork('other.example', 'x.com')).toBe(false);
    expect(relabeller.vouchesForNetwork('', 'x.com')).toBe(false);
  });

  it('compares hosts canonically, so case and a www. prefix cannot slip past', () => {
    const relabeller = createBridgeRelabeller([entry()]);
    expect(relabeller.vouchesForNetwork('MIRROR.example', 'X.com')).toBe(true);
    expect(relabeller.findBridge('www.mirror.example')?.host).toBe('mirror.example');
  });
});

describe('boilerplate stripping', () => {
  it('leaves a bio the pattern does not match exactly as written', () => {
    const bio = 'A bio that mentions mirror.example but carries no notice.';
    expect(stripBridgeBoilerplate(bio, entry())).toBe(bio);
  });

  it('strips every declared variant, so a multilingual notice is not half-removed', () => {
    const multilingual = entry({ boilerplate: [/\s*\(bot\)\s*$/, /\s*\(robot\)\s*$/] });
    expect(stripBridgeBoilerplate('Hola (robot)', multilingual)).toBe('Hola');
    expect(stripBridgeBoilerplate('Hello (bot)', multilingual)).toBe('Hello');
  });
});

describe('upstream profile URLs — one declaration, both directions', () => {
  /**
   * Rendering a link and recognising a pasted one are the same fact stated twice.
   * Held as two tables they drift, and the drift lands on the parsing side, where
   * a search that silently finds nothing looks exactly like "we do not have that
   * account" — so it is asserted as a ROUND TRIP rather than in one direction.
   */
  it.each([
    [FEDERATION_NETWORKS.x, 'nasa'],
    [FEDERATION_NETWORKS.instagram, 'robert.habeck'],
    [FEDERATION_NETWORKS.bluesky, 'georgemonbiot.bsky.social'],
  ])('round-trips a $name handle', (network, handle) => {
    const parsed = parseUpstreamProfileUrl(upstreamProfileUrl(network, handle));
    expect(parsed?.network.id).toBe(network.id);
    expect(parsed?.handle).toBe(handle);
  });

  it('recognises a network by its aliases, not only its canonical host', () => {
    expect(parseUpstreamProfileUrl('https://twitter.com/nasa')?.network.id).toBe('x');
    expect(parseUpstreamProfileUrl('https://x.com/nasa')?.network.id).toBe('x');
    expect(parseUpstreamProfileUrl('https://mobile.x.com/nasa')?.network.id).toBe('x');
    expect(parseUpstreamProfileUrl('https://www.instagram.com/nasa')?.network.id).toBe('instagram');
  });

  it('drops the tracking parameters a pasted URL usually carries', () => {
    expect(parseUpstreamProfileUrl('https://x.com/nasa?s=20&t=abc')?.handle).toBe('nasa');
    expect(parseUpstreamProfileUrl('https://x.com/nasa#bio')?.handle).toBe('nasa');
    expect(parseUpstreamProfileUrl('  https://x.com/nasa  ')?.handle).toBe('nasa');
  });

  it('answers undefined for anything that is not an upstream profile URL', () => {
    expect(parseUpstreamProfileUrl('https://x.com/i/status/123')).toBeUndefined();
    expect(parseUpstreamProfileUrl('https://x.com/')).toBeUndefined();
    expect(parseUpstreamProfileUrl('https://mastodon.social/@alice')).toBeUndefined();
    expect(parseUpstreamProfileUrl('not a url')).toBeUndefined();
    expect(parseUpstreamProfileUrl('javascript:alert(1)')).toBeUndefined();
  });

  it('renders on the canonical host even when parsed from an alias', () => {
    const parsed = parseUpstreamProfileUrl('https://twitter.com/nasa');
    expect(parsed && upstreamProfileUrl(parsed.network, parsed.handle)).toBe('https://x.com/nasa');
  });
});

describe('bsky.social is one network, whichever protocol an account arrives by', () => {
  it('strips a default handle\'s redundant suffix and keeps a custom domain whole', () => {
    expect(blueskyUsernameFromHandle('skylee1.bsky.social')).toBe('skylee1');
    expect(blueskyUsernameFromHandle('gothamist.com')).toBe('gothamist.com');
    expect(blueskyUsernameFromHandle('mayor.nyc.gov')).toBe('mayor.nyc.gov');
    expect(blueskyUsernameFromHandle('jay.bsky.team')).toBe('jay.bsky.team');
    expect(blueskyUsernameFromHandle('bsky.social')).toBe('bsky.social');
  });
});

describe('federatedUsernameFromUpstreamUrl — the search direction', () => {
  /**
   * A pasted profile URL has to arrive at the SAME username the connector
   * stored, or search returns nothing for an account we hold — a result
   * indistinguishable from "we do not have that account", which is why nobody
   * would ever report it.
   */
  it('resolves a pasted URL to the username Oxy stores', () => {
    expect(federatedUsernameFromUpstreamUrl('https://x.com/nasa')).toBe('nasa@x.com');
    expect(federatedUsernameFromUpstreamUrl('https://twitter.com/nasa')).toBe('nasa@x.com');
    expect(federatedUsernameFromUpstreamUrl('https://mobile.x.com/nasa')).toBe('nasa@x.com');
    expect(federatedUsernameFromUpstreamUrl('https://www.instagram.com/natgeo'))
      .toBe('natgeo@instagram.com');
  });

  it('lowercases, because X and Instagram handles are case-insensitive', () => {
    expect(federatedUsernameFromUpstreamUrl('https://x.com/NASA')).toBe('nasa@x.com');
    expect(federatedUsernameFromUpstreamUrl('https://x.com/WIRED')).toBe('wired@x.com');
  });

  it('drops a default Bluesky handle\'s redundant suffix, exactly as ingest does', () => {
    // The case a second, parallel parsing rule would get wrong: it works for X
    // with plain lowercasing and silently fails here.
    expect(federatedUsernameFromUpstreamUrl('https://bsky.app/profile/georgemonbiot.bsky.social'))
      .toBe('georgemonbiot@bsky.social');
    expect(federatedUsernameFromUpstreamUrl('https://bsky.app/profile/gothamist.com'))
      .toBe('gothamist.com@bsky.social');
  });

  it('agrees with what the relabeller would store for the same account', () => {
    // Ingest and search reading one declaration, asserted rather than assumed.
    const relabeller = createBridgeRelabeller([entry({
      host: 'mirror.example',
      network: FEDERATION_NETWORKS.x,
      derive: () => 'NASA',
    })]);
    const viaIngest = relabeller.deriveNetworkIdentity(candidate())?.federatedUsername;
    expect(federatedUsernameFromUpstreamUrl('https://x.com/NASA')).toBe(viaIngest);
  });

  it('answers undefined for anything that is not an upstream profile URL', () => {
    expect(federatedUsernameFromUpstreamUrl('https://mastodon.social/@alice')).toBeUndefined();
    expect(federatedUsernameFromUpstreamUrl('https://x.com/i/status/1')).toBeUndefined();
    expect(federatedUsernameFromUpstreamUrl('nasa')).toBeUndefined();
    expect(federatedUsernameFromUpstreamUrl('')).toBeUndefined();
  });
});

describe('FEP-fffd proxyOf', () => {
  /**
   * The exact bytes momostr.pink serves, fetched 2026-08-02. A Nostr bridge is
   * the only thing in our corpus that publishes `proxyOf` at all, which is also
   * why no shipped entry names this strategy.
   */
  const REAL_MOMOSTR_PROXY_OF = [{
    protocol: 'https://github.com/nostr-protocol/nostr',
    proxied: 'npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m',
    authoritative: true,
  }];

  describe('readProxyDeclarations', () => {
    it('parses a real declaration off the wire', () => {
      expect(readProxyDeclarations(REAL_MOMOSTR_PROXY_OF)).toEqual([{
        protocol: 'https://github.com/nostr-protocol/nostr',
        proxied: 'npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m',
        authoritative: true,
      }]);
    });

    it('defaults authoritative to false when the actor omits it', () => {
      // FEP-fffd leaves the flag optional, and it is the one bit that separates
      // "this actor IS that account" from "this actor is a copy of it".
      const [parsed] = readProxyDeclarations([{ protocol: 'p', proxied: 'q' }]);
      expect(parsed.authoritative).toBe(false);
    });

    it('requires authoritative to be the boolean true, not merely truthy', () => {
      // The remote actor writes this JSON, so it chooses the TYPE as well as the
      // value. `"false"`, `1` and `{}` are all truthy, so a `Boolean(...)` read
      // here would let an actor claim to BE an account while publishing
      // something that reads, to a human, as a denial. `=== true` is what makes
      // the flag mean what it says — and a strict check with no test for it is
      // one refactor away from silently becoming the loose one.
      for (const value of ['false', 'true', 1, {}, []]) {
        const [parsed] = readProxyDeclarations([{ protocol: 'p', proxied: 'q', authoritative: value }]);
        expect(parsed.authoritative).toBe(false);
      }
    });

    it('drops malformed entries rather than inventing fields', () => {
      expect(readProxyDeclarations([
        { protocol: '', proxied: 'q' },
        { protocol: 'p', proxied: '' },
        { protocol: 'p' },
        'not an object',
        null,
        [],
      ])).toEqual([]);
    });

    it('reads a missing or non-array proxyOf as none', () => {
      expect(readProxyDeclarations(undefined)).toEqual([]);
      expect(readProxyDeclarations({ protocol: 'p', proxied: 'q' })).toEqual([]);
    });
  });

  describe('upstreamHandleFromProxyOf', () => {
    const derive = upstreamHandleFromProxyOf({
      protocols: ['https://github.com/nostr-protocol/nostr'],
    });

    it('reads the proxied identifier for a protocol the entry accepts', () => {
      expect(derive(candidate({ proxyOf: REAL_MOMOSTR_PROXY_OF }))).toBe(
        'npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m',
      );
    });

    it('refuses a non-authoritative declaration', () => {
      // A copy does not get to stand in for the account it copied.
      expect(derive(candidate({
        proxyOf: [{ ...REAL_MOMOSTR_PROXY_OF[0], authoritative: false }],
      }))).toBeUndefined();
    });

    it('refuses a protocol the entry does not accept', () => {
      expect(derive(candidate({
        proxyOf: [{ protocol: 'https://example.invalid/other', proxied: 'x', authoritative: true }],
      }))).toBeUndefined();
    });

    it('can map the proxied identifier to a handle', () => {
      const mapped = upstreamHandleFromProxyOf({
        protocols: ['https://atproto.com'],
        handleFromProxied: (proxied) => proxied.replace(/^at:\/\//, '') || undefined,
      });
      expect(mapped(candidate({
        proxyOf: [{ protocol: 'https://atproto.com', proxied: 'at://alice.bsky.social', authoritative: true }],
      }))).toBe('alice.bsky.social');
    });
  });

  describe('it is gated by the registry, not applied globally', () => {
    /**
     * The load-bearing property. `proxyOf` is asserted by the untrusted actor
     * itself, so honouring it wherever it appears would let ANY actor on ANY
     * instance publish `proxied: "elonmusk"` and be stored, rendered and searched
     * as that person. Only a host somebody reviewed can reach this strategy.
     */
    it('re-labels nothing when the actor is on no listed host', () => {
      const relabeller = createBridgeRelabeller([]);
      expect(relabeller.deriveNetworkIdentity(candidate({
        host: 'attacker.example',
        proxyOf: [{ protocol: 'https://x.example', proxied: 'elonmusk', authoritative: true }],
      }))).toBeUndefined();
    });

    it('re-labels nothing from an UNLISTED host even when a listed host uses the strategy', () => {
      const relabeller = createBridgeRelabeller([entry({
        host: 'mirror.example',
        derive: upstreamHandleFromProxyOf({ protocols: ['https://x.example'] }),
      })]);
      const claim = {
        proxyOf: [{ protocol: 'https://x.example', proxied: 'elonmusk', authoritative: true }],
      };
      expect(relabeller.deriveNetworkIdentity(candidate({ host: 'attacker.example', ...claim })))
        .toBeUndefined();
      // …and the very same claim from the REVIEWED host is honoured, which is
      // what makes the previous assertion about trust rather than about parsing.
      expect(relabeller.deriveNetworkIdentity(candidate({ host: 'mirror.example', ...claim }))
        ?.federatedUsername).toBe('elonmusk@x.com');
    });
  });
});

/**
 * The mirror test that does not read prose.
 *
 * A bridge on stock server software has nothing to fingerprint, and the obvious
 * fallback — matching the per-account notice it writes into each bio — fails on
 * LANGUAGE. One deployment served that sentence in English, French and Spanish;
 * an entry listing two of them left every account of the third under the
 * bridge's hostname, notice still in the bio, looking like an ordinary account.
 * `type` is the same claim in a machine-readable field.
 */
describe('upstreamHandleFromAutomatedActor', () => {
  const derive = upstreamHandleFromAutomatedActor();
  const candidate = (over: Partial<NetworkIdentityCandidate>): NetworkIdentityCandidate => ({
    host: 'mastox.eu',
    acct: 'someone@mastox.eu',
    preferredUsername: 'PabloIglesias',
    actorUri: 'https://mastox.eu/users/PabloIglesias',
    actorType: 'Service',
    alsoKnownAs: [],
    fields: [],
    proxyOf: [],
    bio: '',
    ...over,
  });

  it.each(['Service', 'service', 'SERVICE'])(
    'accepts an actor published as %s, whatever its case',
    (actorType) => {
      expect(derive(candidate({ actorType }))).toBe('PabloIglesias');
    },
  );

  it('refuses an Application — that is the SERVER\'s own actor', () => {
    // Mastodon publishes https://<host>/actor as an `Application` named
    // `mastodon.internal`. Accepting it would re-label the instance actor onto
    // the upstream network, which is a false attribution about the operator
    // rather than about a person, but false all the same.
    expect(derive(candidate({ actorType: 'Application', preferredUsername: 'mastodon.internal' })))
      .toBeUndefined();
  });

  it('refuses a Person — the operator\'s own account is not a mirror', () => {
    expect(derive(candidate({ actorType: 'Person', preferredUsername: 'admin' }))).toBeUndefined();
    expect(derive(candidate({ actorType: 'Group' }))).toBeUndefined();
  });

  it('does not read the bio at all, in any language', () => {
    // The whole point: identity no longer depends on wording. A mirror with NO
    // notice still resolves, and a Person carrying one still does not.
    expect(derive(candidate({ bio: '' }))).toBe('PabloIglesias');
    expect(derive(candidate({
      actorType: 'Person',
      bio: '(bot de x a mastodon administrado por mastox.eu, contacte con @admin)',
    }))).toBeUndefined();
  });

  it('refuses an actor with no preferredUsername rather than deriving an empty handle', () => {
    // An empty handle is the signature of a broken derivation and the most
    // destructive outcome available — every actor on the host collapsing onto
    // one identity.
    expect(derive(candidate({ preferredUsername: '   ' }))).toBeUndefined();
  });
});
