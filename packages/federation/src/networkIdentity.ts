/**
 * WHICH HOSTS REPUBLISH ANOTHER NETWORK'S ACCOUNTS, AND HOW TO READ THE REAL
 * IDENTITY BACK OUT OF THEM.
 *
 * A BRIDGE is a fediverse host that mirrors accounts from somewhere else. The
 * account it publishes as `@WIRED@mastox.eu` is not a person on mastox.eu — it is
 * WIRED, on X, copied. Naming that account after the bridge tells a reader
 * nothing they can act on: the hostname is an implementation detail of how the
 * post reached us, and the thing they actually want to know is which account on
 * which network wrote it. So an actor from a listed bridge is stored and rendered
 * under the NETWORK it came from — `@wired@x.com` — exactly as an atproto actor
 * with a custom-domain handle is stored under `bsky.social` rather than under the
 * domain the handle happens to spell.
 *
 * WHY THE MECHANISM LIVES HERE BUT THE ENTRIES DO NOT
 *
 *   Two different questions must stay separate. An app's connector DERIVES the
 *   identity at ingest (`createBridgeRelabeller(entries)` with entries the app
 *   commits and answers for), and oxy-api's `PUT /users/resolve` DECIDES
 *   WHETHER TO BELIEVE IT — that endpoint binds an actor URI's hostname to the
 *   domain the caller asserts, precisely so a service cannot claim to vouch for
 *   a user on a host it does not own. A bridged identity is the one case where
 *   those legitimately differ. The shared package ships the derivation machinery
 *   and network vocabulary; each side keeps its own reviewed list and they fail
 *   CLOSED in both directions — an app that derives for a bridge the API does
 *   not trust simply has its resolve refused, and a host the API trusts that no
 *   app derives for does nothing at all.
 *
 * A WRONG ENTRY HERE MISATTRIBUTES SOMEBODY'S WRITING
 *
 *   That is a heavier failure than the blocklist's. A wrong block loses content
 *   and somebody complains; a wrong bridge entry silently publishes one person's
 *   posts under another person's name, on a network they may not even use. So
 *   every entry records what was actually VERIFIED against a live actor
 *   ({@link FederationBridgeEntry.evidence}) separately from what is merely
 *   ASSUMED ({@link FederationBridgeEntry.assumption}), and every entry an app
 *   ships should carry a stored fixture and a test that fails if its rule stops
 *   round-tripping. Derivation is per-ACTOR and fails closed: an actor that does
 *   not satisfy its bridge's rule keeps the bridge hostname, because a bridge's
 *   own admin and service accounts are real accounts on that host and relabelling
 *   them would invent an upstream person who does not exist.
 *
 * THIS IS NOT THE BLOCKLIST, AND MUST NEVER BE MERGED WITH IT
 *
 *   Blocking and bridge-trust are opposite decisions about a host, and the
 *   blocklist wins: a blocked host is refused before any actor from it is ever
 *   built, so no relabel can resurrect it. Keeping them in separate structures
 *   means neither can be edited into the other by accident.
 */

import { canonicalFederationHost } from './apUri';

/**
 * A network accounts can be bridged FROM.
 *
 * `domain` is the identity domain — the part after the `@` in a rendered handle,
 * and the `domain` bound to a federated Oxy username. It is the network's
 * canonical public host (`x.com`, not `twitter.com`), because that is what a
 * reader recognises and what a profile link resolves to.
 */
export interface FederationNetwork {
  /** Stable key for this network (used to group bridges that mirror the same one). */
  readonly id: string;
  /** Human name, for logs and review output. */
  readonly name: string;
  /** The identity domain handles are rendered and stored under. */
  readonly domain: string;
  /**
   * Every host a profile URL for this network can be pasted from — the canonical
   * one FIRST, then aliases (`x.com` and `twitter.com` are one network;
   * `instagram.com` and `www.instagram.com` differ only by a prefix the
   * canonicaliser already strips).
   */
  readonly profileHosts: readonly string[];
  /** Fixed path segments before the handle (`bsky.app/profile/<handle>` ⇒ `['profile']`). */
  readonly profilePathPrefix: readonly string[];
  /**
   * The LOCAL PART an upstream handle is stored under in Oxy.
   *
   * Not the identity function: X and Instagram treat handles
   * case-insensitively so they are lowered, and a default Bluesky handle drops
   * its now-redundant `.bsky.social` suffix once the domain already says
   * `bsky.social`. It belongs to the NETWORK rather than to any bridge entry
   * because it is a protocol fact about how that network names accounts, not a
   * judgement about an operator.
   *
   * Both the ingest path and the search path go through this ONE function.
   * That is the whole point: a pasted `https://bsky.app/profile/x.bsky.social`
   * has to arrive at the same username the connector stored, or search finds
   * nothing and looks exactly like "we do not have that account".
   */
  readonly storedUsername: (handle: string) => string;
}

/**
 * The networks Oxy re-labels accounts onto.
 *
 * Bluesky is here for a reason beyond bridging: it is the network the atproto
 * connector ingests DIRECTLY, and its domain used to be a constant private to
 * that connector. Both readers now take it from here, so a Bluesky account
 * reaching us over atproto and the same account reaching us over ActivityPub
 * through Bridgy Fed cannot end up under two different domains — which is what
 * would happen if the two paths each named the network themselves.
 */
export const FEDERATION_NETWORKS = {
  x: {
    id: 'x',
    name: 'X',
    domain: 'x.com',
    profileHosts: ['x.com', 'twitter.com', 'mobile.twitter.com', 'mobile.x.com'],
    profilePathPrefix: [],
    storedUsername: (handle) => handle.trim().toLowerCase(),
  },
  instagram: {
    id: 'instagram',
    name: 'Instagram',
    domain: 'instagram.com',
    profileHosts: ['instagram.com'],
    profilePathPrefix: [],
    storedUsername: (handle) => handle.trim().toLowerCase(),
  },
  bluesky: {
    id: 'bluesky',
    name: 'Bluesky',
    domain: 'bsky.social',
    profileHosts: ['bsky.app'],
    profilePathPrefix: ['profile'],
    storedUsername: (handle) => blueskyUsernameFromHandle(handle.trim()),
  },
} as const satisfies Record<string, FederationNetwork>;

/**
 * The upstream profile URL for a handle on a network.
 *
 * Deliberately the SAME declaration {@link parseUpstreamProfileUrl} reads
 * backwards. Rendering a link and recognising a pasted one are the same fact
 * stated in two directions, and holding them as two independent tables is how
 * they drift — with the failure landing on the parsing side, where a search that
 * silently finds nothing is indistinguishable from "we do not have that account"
 * and so nobody ever reports it.
 */
export function upstreamProfileUrl(network: FederationNetwork, handle: string): string {
  const path = [...network.profilePathPrefix, encodeURIComponent(handle)].join('/');
  return `https://${network.profileHosts[0]}/${path}`;
}

/**
 * The network and handle a pasted upstream profile URL names, or `undefined` when
 * it is not one.
 *
 * Query strings and fragments are dropped (a pasted URL usually carries tracking
 * parameters) and a trailing slash is tolerated. Purely syntactic: it never
 * fetches the URL — resolving a user-supplied URL by fetching it would be an SSRF
 * surface, and there is nothing here that needs the network.
 */
export function parseUpstreamProfileUrl(
  candidateUrl: string,
  networks: readonly FederationNetwork[] = Object.values(FEDERATION_NETWORKS),
): { network: FederationNetwork; handle: string } | undefined {
  let url: URL;
  try {
    url = new URL(candidateUrl.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;

  const host = canonicalFederationHost(url.hostname);
  for (const network of networks) {
    if (!network.profileHosts.some((allowed) => canonicalFederationHost(allowed) === host)) continue;
    const handle = profileUrlHandle(url.href, network.profileHosts, network.profilePathPrefix);
    if (handle !== undefined && handle.length > 0) return { network, handle };
  }
  return undefined;
}

/** The Bluesky network's canonical identity domain — see {@link FEDERATION_NETWORKS}. */
export const BSKY_NETWORK_DOMAIN = FEDERATION_NETWORKS.bluesky.domain;

/** A profile field as the actor cache stores it (only what a derivation rule reads). */
export interface BridgedActorField {
  readonly name: string;
  readonly value: string;
}

/**
 * One FEP-fffd `proxyOf` entry: an actor stating, in machine-readable form, that
 * it is a proxy for an object on another protocol.
 *
 * Observed on the wire (momostr.pink, 2026-08-02):
 *
 *     "proxyOf": [{
 *       "protocol": "https://github.com/nostr-protocol/nostr",
 *       "proxied": "npub1sg6plz…",
 *       "authoritative": true
 *     }]
 *
 * `protocol` is a URI naming the upstream protocol, `proxied` its identifier
 * there, and `authoritative` says whether this actor is the canonical
 * representation rather than one copy among several.
 */
export interface ProxyDeclaration {
  readonly protocol: string;
  readonly proxied: string;
  readonly authoritative: boolean;
}

/**
 * Parse an actor's `proxyOf` into well-formed declarations, dropping anything
 * malformed. Pure; accepts `unknown` because it reads an untrusted document.
 *
 * `authoritative` DEFAULTS TO FALSE when absent. FEP-fffd leaves it optional, and
 * the conservative reading is the only safe one here: the flag is what
 * distinguishes "this actor IS that upstream account" from "this actor is one
 * copy of it", and only the former could ever justify moving an identity.
 */
export function readProxyDeclarations(value: unknown): ProxyDeclaration[] {
  if (!Array.isArray(value)) return [];
  const declarations: ProxyDeclaration[] = [];
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const protocol = typeof entry.protocol === 'string' ? entry.protocol.trim() : '';
    const proxied = typeof entry.proxied === 'string' ? entry.proxied.trim() : '';
    if (protocol.length === 0 || proxied.length === 0) continue;
    declarations.push({ protocol, proxied, authoritative: entry.authoritative === true });
  }
  return declarations;
}

/**
 * Everything a derivation rule may look at. Every field is a value the caller has
 * already derived and verified, so a rule never re-parses the actor document.
 */
export interface NetworkIdentityCandidate {
  /** The lowercase host the actor is authoritative for (post-redirect). */
  readonly host: string;
  /** The canonical `user@host` acct — the actor's PROTOCOL address. */
  readonly acct: string;
  /** `preferredUsername` verbatim, case preserved. */
  readonly preferredUsername: string;
  /** The actor's own `id`. */
  readonly actorUri: string;
  /** The AP `type` (`Person` / `Service` / `Application` / …). */
  readonly actorType: string;
  /** `alsoKnownAs`, verbatim (empty when the actor publishes none). */
  readonly alsoKnownAs: readonly string[];
  /** The actor's profile fields (PropertyValue), already sanitized. */
  readonly fields: readonly BridgedActorField[];
  /** The actor's FEP-fffd `proxyOf` declarations (empty when it publishes none). */
  readonly proxyOf: readonly ProxyDeclaration[];
  /** The actor's bio as plain text. */
  readonly bio: string;
}

/**
 * An actor re-labelled onto the network its identity really belongs to.
 *
 * `federatedUsername` MUST end with `@${instanceDomain}` — oxy-api binds a
 * federated username to its domain — and the caller REFUSES a result that does
 * not, rather than minting an identity oxy-api would reject.
 */
export interface NetworkIdentity {
  /** The canonical `<user>@<network-domain>` identity (e.g. `wired@x.com`). */
  readonly federatedUsername: string;
  /** The network domain the identity belongs to (e.g. `x.com`). */
  readonly instanceDomain: string;
  /** The bio with the bridge's own appended boilerplate removed. */
  readonly bio: string;
}

/**
 * App-supplied re-labelling of an ingested actor onto its real network. Returns
 * `undefined` for anything not recognised — which is the overwhelmingly common
 * case, and the correct answer whenever the derivation is not certain.
 */
export type DeriveNetworkIdentity = (
  candidate: NetworkIdentityCandidate,
) => NetworkIdentity | undefined;

/**
 * Whether the people mirrored by a bridge asked to be.
 *
 * Recorded because it is the question a mirrored person asks first, and because
 * it changes what a reasonable response to a complaint is. It deliberately does
 * NOT gate the relabel: an unconsented mirror is still that person's writing, and
 * attributing it to them is more honest than attributing it to the bridge.
 *
 *  - `opt-in`       the upstream account took an action to enable the bridge.
 *  - `unconsented`  the bridge mirrors without asking; removal is on request.
 */
export type BridgeConsentModel = 'opt-in' | 'unconsented';

/** How the upstream handle is recovered from a bridged actor. */
export type BridgeDerivation = (candidate: NetworkIdentityCandidate) => string | undefined;

/** One reviewed bridge. */
export interface FederationBridgeEntry {
  /**
   * The bridge's host, CANONICAL — lowercase, bare host, no scheme, no `www.`.
   * Matching is exact canonical-host membership, so a subdomain is a different
   * host and needs its own reviewed entry.
   */
  readonly host: string;
  /** The network accounts here are mirrored FROM. */
  readonly network: FederationNetwork;
  /** Who runs the bridge, as they identify themselves. */
  readonly operator: string;
  /** The bridge software, as its own nodeinfo reports it. */
  readonly software: string;
  /**
   * Recover the upstream handle from ONE actor, or `undefined` when this actor
   * does not satisfy the rule — which is how the bridge's own admin/service
   * accounts, and anything whose shape changed, are left alone.
   */
  readonly derive: BridgeDerivation;
  /**
   * What to do with the recovered handle's case before storing it.
   *
   *  - `lowercase` the upstream network treats handles case-insensitively, so
   *    lowercasing loses no addressability and keeps the handle rendering like
   *    every other federated handle (AP acct normalisation lowercases them all).
   *  - `preserve`  the handle is a DNS name and is already canonical; touching it
   *    would change what it addresses.
   */
  readonly caseRule: 'lowercase' | 'preserve';
  /**
   * Whether re-labelling this bridge's actors is SAFE TO APPLY yet.
   *
   * Re-labelling does not merely coexist with duplicates, it MANUFACTURES them:
   * two bridges of one network that render as visibly different accounts today
   * both render the SAME handle afterwards — identical, adjacent in search and in
   * follow lists, and reading as a bug in a way the status quo does not. Where a
   * network's collision set is non-empty, the merge has to land first.
   *
   *  - `enabled`        the identity moves.
   *  - `pending_dedup`  the entry is committed and reviewed, and deliberately
   *                     INERT: the derivation is exercised by tests but no actor
   *                     is re-labelled, because doing so would create twins.
   */
  readonly relabel: 'enabled' | 'pending_dedup';
  /**
   * How stable the upstream identifier this rule derives actually is.
   *
   *  - `stable`     an immutable upstream id (an atproto DID, an ORCID iD). Two
   *                 rows sharing it are the same account, permanently.
   *  - `recyclable` a HANDLE. X and Instagram release abandoned handles, so two
   *                 bridges capturing years apart can derive the same key for two
   *                 different humans, and Bluesky handles are mutable — which is
   *                 exactly why the atproto connector keys on the DID instead.
   *
   * Named rather than silently carried: it is the residual risk a merge inherits,
   * and a reader deciding whether to trust a merge needs it stated.
   */
  readonly upstreamIdStability: 'stable' | 'recyclable';
  /**
   * The bridge's own appended boilerplate, to strip from the bio.
   *
   * Per-bridge and anchored, never a general "looks like boilerplate" heuristic:
   * a pattern that does not match leaves the bio EXACTLY as written, which is the
   * only safe behaviour when the alternative is deleting a line the author wrote.
   * Several bridges emit the same notice in more than one language, so this is a
   * list and every variant that has been observed is listed.
   */
  readonly boilerplate: readonly RegExp[];
  /** Whether the mirrored accounts asked to be mirrored. */
  readonly consent: BridgeConsentModel;
  /** What was VERIFIED against a live actor, and where the fixture came from. */
  readonly evidence: string;
  /**
   * What is ASSUMED rather than verified. Empty string means the derivation reads
   * an assertion the actor itself publishes, so nothing is being guessed.
   */
  readonly assumption: string;
  /** `YYYY-MM-DD` — the day the entry took effect. */
  readonly since: string;
}

/**
 * The handle a profile URL addresses: the single path segment that follows the
 * network's fixed profile prefix (`x.com/<handle>` has none, `bsky.app` uses
 * `profile/`), on one of the network's own hosts.
 *
 * Exact — one segment after the prefix and nothing more — so a link to some other
 * page on the same host (`x.com/i/status/123`) yields nothing rather than a
 * plausible-looking wrong handle.
 */
function profileUrlHandle(
  href: string,
  allowedHosts: readonly string[],
  pathPrefix: readonly string[],
): string | undefined {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  const host = canonicalFederationHost(url.hostname);
  if (!allowedHosts.some((allowed) => canonicalFederationHost(allowed) === host)) return undefined;

  const segments = url.pathname.split('/').filter((s) => s.length > 0);
  if (segments.length !== pathPrefix.length + 1) return undefined;
  for (let i = 0; i < pathPrefix.length; i += 1) {
    if (segments[i].toLowerCase() !== pathPrefix[i]) return undefined;
  }
  return decodeURIComponent(segments[pathPrefix.length]);
}

/** Every `href="…"` in a sanitized field value, in document order. */
function fieldHrefs(value: string): string[] {
  const hrefs: string[] = [];
  const pattern = /href="([^"]*)"/gi;
  let match = pattern.exec(value);
  while (match !== null) {
    hrefs.push(match[1]);
    match = pattern.exec(value);
  }
  return hrefs;
}

/**
 * Read the upstream handle out of a named profile field that links to the
 * upstream profile — the STRONGEST rule available, because the bridge is
 * publishing a machine-readable assertion of which account this mirrors rather
 * than leaving us to infer it from the username.
 */
export function upstreamHandleFromProfileField(options: {
  readonly fieldName: string;
  readonly hosts: readonly string[];
  /** Fixed path segments before the handle (`bsky.app/profile/<handle>` ⇒ `['profile']`). */
  readonly pathPrefix?: readonly string[];
}): BridgeDerivation {
  const wanted = options.fieldName.toLowerCase();
  const prefix = options.pathPrefix ?? [];
  return (candidate) => {
    for (const field of candidate.fields) {
      if (field.name.trim().toLowerCase() !== wanted) continue;
      for (const href of fieldHrefs(field.value)) {
        const handle = profileUrlHandle(href, options.hosts, prefix);
        if (handle !== undefined && handle.length > 0) return handle;
      }
    }
    return undefined;
  };
}

/**
 * Read the upstream handle out of `alsoKnownAs` profile URLs — the shape where an
 * actor publishes a profile link there rather than in a named profile field.
 *
 * ⚠ UNMATCHED BY ANY ACTOR WE ACTUALLY HOLD. On all three Bridgy Fed actors
 * captured from production, `alsoKnownAs` contains ONLY the atproto DID
 * (`["did:plc:…"]`) and no `bsky.app` URL, so this returns `undefined` for the
 * entire real corpus; the shipped Bridgy entry reads the `Web site` profile
 * field, which every one of them does carry. Written against the documented
 * shape rather than an observed one — so verify against a live actor before
 * building on it, and do not read a green test suite as evidence that it fires.
 *
 * `alsoKnownAs` is also NOT a generic upstream backlink. It is one on Bridgy,
 * but on the stock-Mastodon mirror farms it is a Mastodon MIGRATION pointer at a
 * sibling farm domain — following it there would attribute an account to
 * whatever that pointer happens to name. Only use this where a reviewed entry
 * states that the bridge publishes an upstream link in that field.
 */
export function upstreamHandleFromAlsoKnownAs(options: {
  readonly hosts: readonly string[];
  /** Fixed path segments before the handle (`bsky.app/profile/<handle>` ⇒ `['profile']`). */
  readonly pathPrefix?: readonly string[];
}): BridgeDerivation {
  const prefix = options.pathPrefix ?? [];
  return (candidate) => {
    for (const href of candidate.alsoKnownAs) {
      const handle = profileUrlHandle(href, options.hosts, prefix);
      if (handle !== undefined && handle.length > 0) return handle;
    }
    return undefined;
  };
}

/**
 * Read the upstream identifier out of an actor's FEP-fffd `proxyOf` declaration.
 *
 * THIS IS A STRATEGY A REVIEWED ENTRY OPTS INTO — NOT A REGISTRY-FREE LANE, AND
 * THE DIFFERENCE IS THE WHOLE SECURITY ARGUMENT.
 *
 *   `proxyOf` is attractive precisely because it is self-describing: the actor
 *   states what it proxies, in a ratified format, with no list to maintain. That
 *   is exactly why it cannot be believed on its own. It is a claim made by an
 *   UNTRUSTED REMOTE ACTOR about its own identity, and every field in it is
 *   attacker-controlled. Honouring it wherever it appears would mean any actor on
 *   any instance could publish
 *
 *       "proxyOf": [{ "protocol": "…", "proxied": "elonmusk", "authoritative": true }]
 *
 *   and be stored, rendered and searchable as that person on that network. The
 *   reviewed bridge list is not bureaucracy around this; it IS the thing that
 *   makes a re-attribution believable, because we checked who runs the host.
 *
 *   Inside an entry the claim is safe for the same reason the entry's other rules
 *   are: we already decided we believe this operator about who it mirrors. So the
 *   strategy exists, it is tested, and it is reachable only from a host somebody
 *   reviewed.
 *
 * `authoritative` must be true — a non-authoritative proxy says the actor is one
 * copy of the upstream object, not that it stands in for it.
 *
 * NOTHING WE INGEST USES THIS YET. The only actors in our corpus that publish
 * `proxyOf` are the two Nostr bridges, and Nostr identities are npubs with no
 * `@handle@domain` form to re-label onto, so no shipped entry names it. It is
 * here so a bridge that adopts FEP-fffd needs an entry rather than new code —
 * do not read its passing tests as evidence that it fires in production.
 */
export function upstreamHandleFromProxyOf(options: {
  /** The protocol URIs this entry accepts, exactly as the actor spells them. */
  readonly protocols: readonly string[];
  /** Map the raw `proxied` identifier to an upstream handle; omit for verbatim. */
  readonly handleFromProxied?: (proxied: string) => string | undefined;
}): BridgeDerivation {
  const accepted = new Set(options.protocols.map((protocol) => protocol.trim().toLowerCase()));
  const toHandle = options.handleFromProxied ?? ((proxied: string) => proxied);
  return (candidate) => {
    for (const declaration of candidate.proxyOf) {
      if (!declaration.authoritative) continue;
      if (!accepted.has(declaration.protocol.trim().toLowerCase())) continue;
      const handle = toHandle(declaration.proxied);
      if (handle !== undefined && handle.length > 0) return handle;
    }
    return undefined;
  };
}

/**
 * Use the actor's own `preferredUsername` as the upstream handle, but ONLY for an
 * actor that carries one of the bridge's mirror notices.
 *
 * The notice is what distinguishes a mirrored account from a real account on the
 * bridge host: the operator's own admin account lives there too and is not a
 * mirror of anything. Without the marker requirement this rule would relabel that
 * person onto a network they may not even be on.
 */
/**
 * A mirror identified by the actor DECLARING ITSELF AUTOMATED, with the handle
 * read from `preferredUsername`.
 *
 * For a bridge that runs stock server software there is nothing to fingerprint:
 * somebody points a mirror bot at an ordinary instance and the result is
 * indistinguishable from any other server. The tempting fallback is to match the
 * per-account notice such a bridge writes into each bio — and that fails, because
 * a notice is free text with LANGUAGES. One deployment served the same sentence
 * in English, French and Spanish; an entry listing two of them silently left
 * every account of the third under the bridge's own hostname, with the notice
 * still in its bio, looking exactly like an ordinary account.
 *
 * `type` is the same claim without the prose. ActivityPub already distinguishes
 * an automated actor (`Service`/`Application`) from a `Person`, every mirror is
 * published as one, and the operator's own account is not — so the bridge's
 * machine-readable declaration replaces a guess about wording. It is still a
 * per-ACTOR proof, which is what keeps a human on that host from being
 * re-attributed to another network.
 *
 * NOT a general "this actor is a bot" rule: it is only ever consulted for a host
 * already reviewed into a bridge policy. Plenty of ordinary fediverse accounts
 * are `Service`, and none of them are on a listed bridge.
 */
export function upstreamHandleFromAutomatedActor(): BridgeDerivation {
  return (candidate) => {
    // `Service` ONLY. `Application` is by convention the SERVER'S OWN actor —
    // Mastodon publishes `https://<host>/actor` as an `Application` named
    // `mastodon.internal` — so accepting it would re-label the instance actor
    // itself onto the upstream network. Caught by an existing guard rather than
    // by review, which is the whole reason that guard is there.
    if (candidate.actorType.trim().toLowerCase() !== 'service') return undefined;
    const handle = candidate.preferredUsername.trim();
    return handle.length > 0 ? handle : undefined;
  };
}

export function upstreamHandleFromPreferredUsername(markers: readonly RegExp[]): BridgeDerivation {
  return (candidate) => {
    if (!markers.some((marker) => marker.test(candidate.bio))) return undefined;
    const handle = candidate.preferredUsername.trim();
    return handle.length > 0 ? handle : undefined;
  };
}

/**
 * The username a Bluesky handle is stored under, given that the instance domain
 * is ALWAYS `bsky.social`.
 *
 * A Bluesky handle is a whole DNS name identifying the account, not a `local@host`
 * address, so the account is on the Bluesky network however many labels the handle
 * has. Once the instance domain is already `bsky.social`, the `.bsky.social`
 * suffix on a DEFAULT handle is redundant and is dropped — otherwise the handle
 * renders as the doubled `@skylee1.bsky.social@bsky.social`. A CUSTOM domain
 * handle is not a `.bsky.social` handle, so it is kept whole:
 *
 *   - `skylee1.bsky.social` → `skylee1`
 *   - `gothamist.com`       → `gothamist.com`
 *   - `mayor.nyc.gov`       → `mayor.nyc.gov`   (never the bogus `nyc.gov` instance)
 *   - `jay.bsky.team`       → `jay.bsky.team`   (`.bsky.team` is not `.bsky.social`)
 *
 * Exported, and used by BOTH paths a Bluesky account can reach us by — the atproto
 * connector reading it directly, and the Bridgy Fed entry below reading it over
 * ActivityPub. That is the point: the same account arriving by two protocols has
 * to produce the same username or the two rows are two people.
 *
 * `bsky.social` itself is guarded: stripping would leave an empty username, so the
 * whole handle is kept.
 */
export function blueskyUsernameFromHandle(handle: string): string {
  const suffix = `.${FEDERATION_NETWORKS.bluesky.domain}`;
  return handle !== FEDERATION_NETWORKS.bluesky.domain && handle.endsWith(suffix)
    ? handle.slice(0, -suffix.length)
    : handle;
}

/** A reviewed bridge registry, and the readers an app drives it with. */
export interface BridgeRelabeller {
  /** The reviewed entry for a host, or `undefined` — most hosts are not bridges. */
  findBridge: (host: string) => FederationBridgeEntry | undefined;
  /**
   * Whether `actorHost` is a reviewed bridge mirroring `networkDomain`. Both
   * halves must match: a bridge vouches ONLY for the one network it mirrors, so
   * being listed is never on its own a licence to claim any domain.
   */
  vouchesForNetwork: (actorHost: string, networkDomain: string) => boolean;
  /** The {@link DeriveNetworkIdentity} hook an ingest path installs. */
  deriveNetworkIdentity: DeriveNetworkIdentity;
}

/**
 * Build the readers for a set of reviewed bridge entries.
 *
 * The entries are a PARAMETER and this package ships none. Deciding that a given
 * operator may be trusted to re-attribute somebody's account is a moderation
 * judgement, not a platform fact — bake one app's list in here and every Oxy app
 * silently inherits it, including consent calls their owners never made. Oxy holds
 * the capability; the app holds the policy, commits it, and answers for it.
 *
 * A blocked host must be refused by the caller's domain policy BEFORE this is
 * consulted: blocking and bridge-trust are opposite decisions about a host and the
 * block wins. No blocklist is accepted here, so this can never be mistaken for the
 * place that decision is made.
 */
export function createBridgeRelabeller(
  entries: readonly FederationBridgeEntry[],
): BridgeRelabeller {
  const byHost = new Map<string, FederationBridgeEntry>(
    entries.map((entry) => [canonicalFederationHost(entry.host), entry]),
  );
  const findBridge = (host: string): FederationBridgeEntry | undefined =>
    byHost.get(canonicalFederationHost(host));

  return {
    findBridge,
    vouchesForNetwork: (actorHost, networkDomain) => {
      const bridge = findBridge(actorHost);
      if (!bridge) return false;
      return canonicalFederationHost(bridge.network.domain) === canonicalFederationHost(networkDomain);
    },
    deriveNetworkIdentity: (candidate) => {
      const entry = findBridge(candidate.host);
      if (!entry) return undefined;
      // A `pending_dedup` entry is committed, reviewed and deliberately inert:
      // re-labelling it would manufacture visible twins of accounts we already
      // hold under the same derived handle.
      if (entry.relabel !== 'enabled') return undefined;

      const derived = entry.derive(candidate);
      if (derived === undefined) return undefined;

      const handle = entry.caseRule === 'lowercase' ? derived.trim().toLowerCase() : derived.trim();
      // An empty handle is the signature of a BROKEN derivation, not of an
      // unusual account — and it is the most destructive possible outcome, since
      // every actor on the domain would collapse onto one identity. We hold
      // federated actors with no `preferredUsername` at all, so this is reachable
      // rather than theoretical. An `@` or `/` would likewise produce an identity
      // that reads as a different account than it addresses.
      if (handle.length === 0 || handle.includes('@') || handle.includes('/')) return undefined;

      const instanceDomain = canonicalFederationHost(entry.network.domain);
      if (instanceDomain.length === 0) return undefined;

      return {
        federatedUsername: `${handle}@${instanceDomain}`,
        instanceDomain,
        bio: stripBridgeBoilerplate(candidate.bio, entry),
      };
    },
  };
}

/** Strip a bridge's own boilerplate, leaving anything it does not match untouched. */
export function stripBridgeBoilerplate(bio: string, entry: FederationBridgeEntry): string {
  let result = bio;
  for (const pattern of entry.boilerplate) {
    result = result.replace(pattern, '');
  }
  return result.trim();
}

/**
 * The exact federated username Oxy stores for a pasted upstream profile URL —
 * `https://x.com/NASA` → `nasa@x.com`, `https://bsky.app/profile/alice.bsky.social`
 * → `alice@bsky.social` — or `undefined` when the URL names no known network.
 *
 * This is the SEARCH direction of the same declaration the ingest path reads
 * forwards, and it deliberately routes through `network.storedUsername` rather
 * than reimplementing the normalisation. A search built on a second, parallel
 * rule would work for X (where the rule is just lowercasing) and fail silently
 * for Bluesky (where a default handle's `.bsky.social` suffix is dropped),
 * returning nothing for an account we hold — a result indistinguishable from
 * "we do not have that account", which is why nobody would ever report it.
 *
 * Purely syntactic: it never fetches the URL. Resolving a user-supplied URL by
 * fetching it would be an SSRF surface, and nothing here needs the network.
 */
export function federatedUsernameFromUpstreamUrl(
  candidateUrl: string,
  networks: readonly FederationNetwork[] = Object.values(FEDERATION_NETWORKS),
): string | undefined {
  const parsed = parseUpstreamProfileUrl(candidateUrl, networks);
  if (!parsed) return undefined;

  const local = parsed.network.storedUsername(parsed.handle);
  if (local.length === 0 || local.includes('@') || local.includes('/')) return undefined;

  return `${local}@${canonicalFederationHost(parsed.network.domain)}`;
}
