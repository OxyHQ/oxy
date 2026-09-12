import {
  FEDERATION_NETWORKS,
  blueskyUsernameFromHandle,
  createBridgeRelabeller,
  upstreamHandleFromAutomatedActor,
  upstreamHandleFromProfileField,
  type FederationBridgeEntry,
} from '@oxy.so/federation';

/**
 * Oxy owns the reviewed identity policy for every ecosystem app (issue #1253).
 * These entries move Mention's reviewed operator evidence unchanged into the
 * identity authority. @oxy.so/federation supplies the common mechanism.
 */
const BIRDSITELIVE_NOTICE_TAIL =
  "\\.\\s*Its author can't see your replies\\.\\s*If you find this service useful, "
  + 'please consider supporting us via our Patreon\\.\\s*$';

function birdsiteLiveNotice(network: string): RegExp {
  return new RegExp(`\\s*This account is a replica from ${network}${BIRDSITELIVE_NOTICE_TAIL}`);
}

/** THE COMMITTED BRIDGE POLICY. */
export const FEDERATION_BRIDGE_POLICY: readonly FederationBridgeEntry[] = [
  {
    host: 'bird.makeup',
    network: FEDERATION_NETWORKS.x,
    operator: 'Vincent Cloutier (bird.makeup)',
    software: 'BirdsiteLive',
    derive: upstreamHandleFromProfileField({ fieldName: 'Official', hosts: ['twitter.com', 'x.com'], repairRepeatedHttpsScheme: true, requireRelMe: true }),
    caseRule: 'lowercase',
    relabel: 'enabled',
    upstreamIdStability: 'recyclable',
    boilerplate: [birdsiteLiveNotice('Twitter')],
    consent: 'unconsented',
    evidence:
      'Every mirrored actor publishes an `Official` profile field whose rel="me" link is '
      + 'https://twitter.com/<handle> — the bridge states which upstream account it mirrors, so the '
      + 'handle is read from that assertion rather than inferred from the username. Verified against '
      + 'the stored actor rows for typecache, gorskon and giswqs, and a live fetch of '
      + 'bird.makeup/users/nasa. Enabled standalone because we hold actors from only two of the six '
      + 'live X bridges and zero cross-bridge duplicates: the wire-verified nasa collision between '
      + 'bird.makeup and birdmakeup.sboulema.nl exists in the world but not in our corpus.'
      + ' NO HISTORY IS IMPORTABLE FROM THIS BRIDGE, AND THAT IS NOT OUR BUG: every actor here '
      + 'serves a bare `{"type":"Collection"}` outbox — no `totalItems`, no `first`, no '
      + '`orderedItems` — so there is no page to walk and the outbox backfill correctly imports '
      + 'nothing. Verified 2026-08-03 against elonmusk, typecache, gorskon and giswqs; three of '
      + 'those are accounts we already hold, so this is how BirdsiteLive behaves rather than '
      + 'something about one account. A bridged X profile therefore shows an empty timeline until '
      + 'somebody follows it and posts start arriving by delivery. Do not read that emptiness as a '
      + 'broken import and go looking for the fault in `syncOutboxPosts`.',
    assumption:
      'That an X handle identifies one person over time. X releases abandoned handles, so two '
      + 'bridges capturing years apart could derive the same key for two different humans — the '
      + 'residual named by `upstreamIdStability: recyclable`, which is why the merge refuses on '
      + 'sharply disagreeing profiles rather than merging on the key alone.',
    since: '2026-08-02',
  },
  {
    host: 'kilogram.makeup',
    network: FEDERATION_NETWORKS.instagram,
    operator: 'Vincent Cloutier (bird.makeup)',
    software: 'BirdsiteLive',
    derive: upstreamHandleFromProfileField({ fieldName: 'Official', hosts: ['instagram.com'], repairRepeatedHttpsScheme: true, requireRelMe: true }),
    caseRule: 'lowercase',
    relabel: 'enabled',
    upstreamIdStability: 'recyclable',
    boilerplate: [birdsiteLiveNotice('Instagram')],
    consent: 'unconsented',
    evidence:
      'Same software and the same `Official` rel="me" assertion as bird.makeup, pointing at '
      + 'https://www.instagram.com/<handle>. Verified against the stored rows for robert.habeck, '
      + 'umwelthilfe and plex — note Instagram handles may contain dots, which the '
      + 'single-path-segment rule preserves. The only live Instagram bridge, so its collision set '
      + 'is empty; treat that as a fact about today, since the software is self-hostable.'
      + ' The empty-outbox behaviour recorded on bird.makeup holds here too — a bare '
      + '`{"type":"Collection"}`, verified 2026-08-03 against plex, robert.habeck and umwelthilfe '
      + '— which is what the shared software predicts, and is now checked rather than assumed.',
    assumption:
      'That an Instagram handle identifies one person over time — Instagram releases abandoned '
      + 'handles, the same residual as bird.makeup.',
    since: '2026-08-02',
  },
  {
    host: 'mastox.eu',
    network: FEDERATION_NETWORKS.x,
    operator: 'mastox.eu (contact @admin@mastox.eu)',
    software: 'Mastodon (stock; no bridge software to fingerprint)',
    // IDENTITY COMES FROM `type`, NOT FROM THE BIO — AND THAT REPLACED A
    // MARKER, WHICH IS THE POINT.
    //
    // This matched the per-account notice mastox writes into each mirrored bio.
    // It listed English and French; the notice also exists in SPANISH, so 18 of
    // the 50 mastox actors we hold were never re-labelled — they kept
    // `@name@mastox.eu` with the notice still in the bio, looking to a reader
    // like an ordinary Mastodon account. Nothing errored, and nobody would
    // report it. Widening the pattern to match the notice's SHAPE fixed those 18
    // and still left identity resting on prose, one wording change from
    // breaking again.
    //
    // The operator already declares it in a machine-readable field: every mirror
    // here is an ActivityPub `Service`, its own `@admin` is a `Person` (both
    // measured against the live host). Same claim, no language.
    //
    // NOT "relabel the whole host, exclude the admin", which is simpler and
    // inverts the direction of failure. Registrations are closed here today, but
    // an exclusion list is unbounded and unknowable, and one miss publishes a
    // real person as an X account they may not have — the impersonation-shaped
    // error this file calls heavier than a wrong block. Asking each actor what
    // it is needs no list at all.
    derive: upstreamHandleFromAutomatedActor(),
    caseRule: 'lowercase',
    relabel: 'enabled',
    upstreamIdStability: 'recyclable',
    // TEXT CLEANING ONLY, and no longer load-bearing for identity — that split
    // is what makes matching prose acceptable here. A pattern that misses now
    // leaves one operator sentence in a bio; it can no longer decide whose
    // account this is. Kept SHAPE-matched so a fourth language cleans itself.
    boilerplate: [
      /\s*\(bot\b[^)]{0,160}\bmastox\.eu\b[^)]{0,160}@admin[^)]{0,80}\)\s*$/i,
    ],
    consent: 'unconsented',
    evidence:
      'The instance describes itself as "une instance Mastodon de miroir non officiels de comptes X '
      + 'vers Mastodon", and every mirrored actor appends a per-account notice naming itself a bot '
      + 'from X — which is what identifies a mirror here, since the operator\'s own @admin account '
      + 'lives on the same host and carries no such notice. Verified against the stored rows for '
      + 'mehdirhasan, FranceskAlbs and gbsumudflotilla (English notice) and a live fetch of '
      + 'mastox.eu/users/RERB (French notice). The handle comes from preferredUsername and NEVER '
      + 'from the actor URI, which is numeric on some rows (/ap/users/116193264000459783).',
    assumption:
      'That the mirrored account\'s preferredUsername equals the upstream X handle. Unlike the '
      + 'BirdsiteLive bridges, a mastox.eu actor publishes NO link to the X account it mirrors — no '
      + 'alsoKnownAs, no rel="me" to x.com — so this mapping rests on the instance-level '
      + 'declaration plus the naming convention, and is the one derivation here that is not read '
      + 'off an assertion the actor makes about itself.',
    since: '2026-08-02',
  },
  {
    // The `bsky.app/profile/<handle>` link carries the FULL Bluesky handle, so the
    // same `.bsky.social`-suffix rule the atproto connector applies has to run
    // here too — without it `georgemonbiot.bsky.social` would be stored as the
    // doubled `@georgemonbiot.bsky.social@bsky.social` and would NOT match the row
    // the direct connector already holds for that account.
    host: 'bsky.brid.gy',
    network: FEDERATION_NETWORKS.bluesky,
    operator: 'Ryan Barrett (Bridgy Fed)',
    software: 'bridgy-fed',
    derive: (candidate) => {
      const dids = candidate.alsoKnownAs.filter(value => /^did:(plc|web):[^\s]+$/.test(value));
      if (new Set(dids).size !== 1) return undefined;
      const handle = upstreamHandleFromProfileField({
        fieldName: 'Web site',
        requireRelMe: true,
        hosts: ['bsky.app'],
        pathPrefix: ['profile'],
      })(candidate);
      return handle === undefined ? undefined : blueskyUsernameFromHandle(handle);
    },
    caseRule: 'preserve',
    // Enabled now that the merge sees ACROSS protocols. Re-labelling here derives
    // `@handle@bsky.social`, which is exactly what the atproto connector already
    // renders for the same account — 79 of our 815 Bridgy actors are accounts we
    // hold natively — so this was deliberately inert until a bridged copy could
    // adopt the native row's Oxy user rather than mint a twin. Both directions now
    // route through `resolveFederatedActorIdentity`, and it matches a native row
    // by its `username@domain` identity as well as by `networkAcct`, so no
    // backfill of the 10,066 native rows is required for it to work.
    relabel: 'enabled',
    upstreamIdStability: 'stable',
    boilerplate: [
      /\s*🌉\s*\S+\s+from\s+🦋\s+\S+, follow (?:@bsky\.brid\.gy|\S+) to interact\s*$/u,
    ],
    consent: 'opt-in',
    evidence:
      'Bridgy Fed only bridges a Bluesky account once that account opts in, and each bridged actor '
      + 'publishes a `Web site` rel="me" link to https://bsky.app/profile/<handle> plus its atproto '
      + 'DID in alsoKnownAs — the same DID the atproto connector keys its own row on, which is what '
      + 'makes the two paths provably the same account and why upstreamIdStability is stable. '
      + 'Verified against the stored rows for thistleandmoss.com, georgemonbiot.bsky.social and '
      + 'assignedmale.bsky.social, and a live fetch of '
      + 'bsky.brid.gy/ap/did:plc:z72i7hdynmk6r22z27h6tvur.',
    assumption: '',
    since: '2026-08-02',
  },
];


export const federationBridges = createBridgeRelabeller(FEDERATION_BRIDGE_POLICY);
