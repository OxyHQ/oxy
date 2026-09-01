/**
 * ActivityPub URI parsing + host canonicalisation + per-instance domain policy.
 *
 * `canonicalFederationHost` / `isSameFederationHost` are the one rule for "are
 * these the same host", and every domain comparison the policy makes is built
 * out of them. `extractActorUriFromActivityId` is pure and domain-agnostic. The
 * blocked-domain check and the local-post-id extractor are DOMAIN-SCOPED — they
 * depend on which hosts an app mints its own URIs under and which identity apex
 * publishes its own users — so they come from a per-instance
 * {@link createDomainPolicy} rather than a module-level constant.
 */

/** Path segments that typically separate an actor path from a post ID in ActivityPub URIs. */
const POST_PATH_SEGMENTS = new Set(['statuses', 'posts', 'notes', 'objects', 'activities']);

/**
 * THE FORM THIS ENGINE COMPARES HOSTS IN — trimmed, lowercased, one leading
 * `www.` removed, and nothing else.
 *
 * It is exported because it is not an implementation detail: it decides whether
 * two spellings of a host are the SAME host, and {@link createDomainPolicy} —
 * the blocked-domain gate every inbound activity and every actor fetch passes
 * through — is built out of this exact function. A consumer that keeps its own
 * copy of the rule (a moderation blocklist, a transparency page, a content
 * purge) is keeping a second opinion about which hosts are which, and the moment
 * the two drift the consumer acts on domains the engine never refused. For a
 * consumer whose action is irreversible that difference is deleted content.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 *   It does not strip a TRAILING DOT. `example.com.` is the fully-qualified
 *   spelling of `example.com` in DNS, but it is a different string here — and
 *   also on the wire, because `new URL('https://example.com./x').hostname`
 *   preserves the dot and that value is what the engine feeds in. So the two
 *   spellings do not match each other, in this function and in the engine
 *   alike. Widening that is a POLICY decision (it makes a blocklist match hosts
 *   it does not literally name) and belongs to whoever owns the policy, not to
 *   a string transform.
 *
 *   It does not perform IDNA. The input is expected to be an ASCII host in the
 *   form the WHATWG URL parser produces — `new URL(...).hostname` has already
 *   applied ToASCII, so an internationalised host arrives as punycode
 *   (`xn--ber-goa.example`). A host spelled in unicode is lowercased but NOT
 *   converted, so it will not match its own punycode wire form. Callers that
 *   accept operator-typed hosts must convert them before comparing.
 *
 * @param host a bare host — no scheme, no port, no path.
 */
export function canonicalFederationHost(host: string): string {
  const value = host.trim().toLowerCase();
  return value.startsWith('www.') ? value.slice(4) : value;
}

/**
 * Whether two spellings name the same host under {@link canonicalFederationHost}.
 *
 * This is the question a caller actually has ("is the host on this activity the
 * host we blocked?"), and it exists so that asking it does not require each
 * caller to assemble its own comparison around the normaliser. Assembling one is
 * where the mistakes happen, and they are quiet ones: a comparison that
 * lowercases but forgets `www.`, or that allows `www.` on one side only and so
 * answers differently depending on argument order, looks correct at every call
 * site and is wrong for exactly the hosts an evasive instance will use.
 *
 * A blank string names no host, so it matches nothing — including another blank.
 * That is the same answer {@link DomainPolicy.isBlockedDomain} gives it: a host
 * that is not named is not in any set.
 */
export function isSameFederationHost(a: string, b: string): boolean {
  const canonicalA = canonicalFederationHost(a);
  if (canonicalA.length === 0) return false;
  return canonicalA === canonicalFederationHost(b);
}

/**
 * Given an ActivityPub activity/object ID (URL), extract the actor URI by
 * trimming everything from the first recognised post-path segment onward.
 *
 * e.g. "https://mastodon.social/users/alice/statuses/12345"
 *    → "https://mastodon.social/users/alice"
 *
 * Returns null when the URL is malformed or no post-path segment is found.
 */
export function extractActorUriFromActivityId(activityId: string): string | null {
  try {
    const url = new URL(activityId);
    const segments = url.pathname.split('/').filter(Boolean);
    const statusIdx = segments.findIndex((s) => POST_PATH_SEGMENTS.has(s));
    if (statusIdx < 1) return null;
    return `${url.origin}/${segments.slice(0, statusIdx).join('/')}`;
  } catch {
    return null;
  }
}

/** Configuration for a per-instance {@link DomainPolicy}. */
export interface DomainPolicyConfig {
  /** The app's federation domain (where it mints webfinger / inbox / collection URIs). */
  domain: string;
  /** The host that owns actor URIs; defaults to `domain`. */
  actorDomain?: string;
  /**
   * Oxy's identity apex (e.g. `oxy.so`). Every Oxy/Mention user is ALSO published
   * as `acct:<username>@<apex>` via the DID layer, so an actor on this host is one
   * of OUR OWN users — resolving it as remote would create duplicate actor rows
   * for local users. Blocked when set.
   */
  identityApex?: string;
  /** Additional explicitly-blocked domains (case-insensitive). */
  blockedDomains?: Iterable<string>;
}

/** Per-instance domain policy: which hosts are ours/blocked, and our own post-URI shape. */
export interface DomainPolicy {
  /**
   * True when a domain should be rejected for federation — our own ActivityPub
   * domains, the Oxy identity apex (both publish our own users), or an explicitly
   * configured blocked domain.
   */
  isBlockedDomain(domain: string): boolean;
  /**
   * Extract a local Post id from an ActivityPub object URI that points at one of
   * our own posts (`https://<our-domain>/ap/users/<username>/posts/<postId>`).
   * Returns null when the URI host is not one of ours or the path does not match
   * the canonical scheme (the object is remote, resolved by activityId instead).
   */
  extractLocalPostId(objectUri: string): string | null;
}

/**
 * Build the per-instance {@link DomainPolicy} from an app's domain configuration.
 */
export function createDomainPolicy(config: DomainPolicyConfig): DomainPolicy {
  const localDomains = new Set([
    canonicalFederationHost(config.domain),
    canonicalFederationHost(config.actorDomain ?? config.domain),
  ]);
  const identityApex = config.identityApex ? canonicalFederationHost(config.identityApex) : undefined;
  const blocked = new Set<string>();
  for (const d of config.blockedDomains ?? []) {
    blocked.add(canonicalFederationHost(d));
  }

  return {
    isBlockedDomain(domain: string): boolean {
      const d = canonicalFederationHost(domain);
      return localDomains.has(d) || (identityApex !== undefined && d === identityApex) || blocked.has(d);
    },
    extractLocalPostId(objectUri: string): string | null {
      let parsed: URL;
      try {
        parsed = new URL(objectUri);
      } catch {
        return null;
      }
      if (!localDomains.has(canonicalFederationHost(parsed.hostname))) return null;
      const match = parsed.pathname.match(/^\/ap\/users\/[^/]+\/posts\/([^/]+)\/?$/);
      return match ? match[1] : null;
    },
  };
}
