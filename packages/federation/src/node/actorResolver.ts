/**
 * Resolution, caching and refresh of remote ActivityPub actors.
 *
 * Extracted behaviour-identically from Mention's `ActorService`. The engine owns
 * the PROTOCOL — webfinger resolution, the signed actor fetch, the redirect /
 * WebFinger fallback, the 410-Gone tombstone, the self-consistency + same-origin
 * guards, and the staleness/refresh policy. Everything app-specific is injected:
 *
 *  - the FederatedActor CACHE lives in the app DB, reached through a
 *    {@link FederatedActorStore} adapter ("bring your own store" — no data move),
 *  - the actor↔Oxy-user bridge is the injected {@link ActorResolverIdentity}
 *    (`PUT /users/resolve` + actor-gone archive),
 *  - the signed AP fetch + the SSRF-safe WebFinger fetch are injected transports,
 *  - remote-text normalization is an injected {@link ActorTextAdapter} (the app's
 *    canonical normalizer + sanitizer), so the engine ships no HTML deps.
 *
 * The resolver is generic over the app's stored actor record shape (`TActor`,
 * e.g. Mention's `IFederatedActor`) so callers keep full typing on the returned
 * document.
 */

import { canonicalFederationHost, isSameFederationHost } from '../apUri';
import {
  readProxyDeclarations,
  type DeriveNetworkIdentity,
  type NetworkIdentity,
  type NetworkIdentityCandidate,
} from '../networkIdentity';
import type { NormalizedExternalActor } from '../index';
import type { SignedFetch } from './signedFetch';
import type { ReportActorGoneOutcome } from './identityBridge';

/**
 * Minimum interval between background actor refreshes for the same actor.
 * Prevents refresh storms when a profile is viewed repeatedly in a short window.
 */
const ACTOR_REFRESH_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

/** Staleness threshold after which a cached actor is eligible for a background re-fetch. */
const ACTOR_STALE_MS = 24 * 60 * 60 * 1000; // 24 hours

/** The AP content type asked for on signed actor/collection fetches. */
const AP_CONTENT_TYPE = 'application/activity+json';

/** Maximum decompressed response sizes accepted from untrusted federation hosts. */
const ACTOR_BODY_MAX_BYTES = 1024 * 1024;
const COLLECTION_BODY_MAX_BYTES = 64 * 1024;
const ERROR_BODY_MAX_BYTES = 4 * 1024;

async function readBoundedResponseBody(res: Response, maxBytes: number): Promise<string> {
  const contentLength = res.headers.get('content-length');
  if (contentLength) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`Remote response exceeds ${maxBytes} byte limit`);
    }
  }

  if (!res.body) return '';

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytesRead = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`Remote response exceeds ${maxBytes} byte limit`);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function readBoundedJson(res: Response, maxBytes: number): Promise<Record<string, unknown>> {
  const body = await readBoundedResponseBody(res, maxBytes);
  // An empty body is a REMOTE's answer, not a parser error. Without this,
  // `JSON.parse('')` throws a SyntaxError whose message names a column number,
  // which is a worse thing to find in a federation log than the fact that the
  // instance sent nothing.
  if (body.length === 0) throw new Error('Remote response has no body');
  const value: unknown = JSON.parse(body);
  const record = asRecord(value);
  if (!record) throw new Error('Remote response is not a JSON object');
  return record;
}

function isApActorContentType(type: string | undefined): boolean {
  if (!type) return false;
  const base = type.split(';')[0]?.trim().toLowerCase();
  return base === 'application/activity+json' || base === 'application/ld+json';
}

/** The minimal fields the resolver reads off / writes to a stored actor record. */
export interface FederatedActorRecordBase {
  _id?: unknown;
  uri: string;
  acct?: string;
  oxyUserId?: string | null;
  avatarUrl?: string;
  headerUrl?: string;
  publicKeyPem?: string;
  lastFetchedAt?: Date | null;
}

/** A verified profile field (PropertyValue) stored on the actor cache. */
export interface FederatedActorField {
  name: string;
  value: string;
  verifiedAt?: Date;
}

/** The full write shape the resolver upserts into the actor cache. */
export interface FederatedActorUpsert {
  protocol: 'activitypub';
  uri: string;
  username: string;
  domain: string;
  acct: string;
  summary: string;
  avatarUrl?: string;
  headerUrl?: string;
  inboxUrl?: string;
  outboxUrl?: string;
  sharedInboxUrl?: string;
  followersUrl?: string;
  followingUrl?: string;
  publicKeyPem?: string;
  publicKeyId?: string;
  type: string;
  manuallyApprovesFollowers: boolean;
  discoverable: boolean;
  memorial: boolean;
  suspended: boolean;
  fields: FederatedActorField[];
  featuredUrl?: string;
  featuredTagsUrl?: string;
  alsoKnownAs?: string[];
  /**
   * The `<handle>@<network-domain>` identity this actor was re-labelled onto, when
   * it came from a bridge; absent for the ordinary actor whose identity is simply
   * its acct.
   *
   * Persisted rather than re-derived on demand because it is the key two rows are
   * the SAME PERSON on: the same X account mirrored by two different bridges
   * produces two actor rows with different URIs and different accts, and this is
   * the only field on which they match. An app that de-duplicates bridged
   * identities queries it; one that does not can ignore it.
   */
  networkAcct?: string;
  remoteCreatedAt?: Date;
  followersCount: number;
  followingCount: number;
  postsCount: number;
  lastFetchedAt: Date;
}

/** Bring-your-own-store: the AP actor cache stays in the app DB behind this adapter. */
export interface FederatedActorStore<TActor extends FederatedActorRecordBase> {
  /** Look up a cached actor by its protocol URI. */
  findActorByUri(uri: string): Promise<TActor | null>;
  /** Upsert (create-or-update) the actor cache row keyed by `uri`. */
  upsertActor(uri: string, update: FederatedActorUpsert): Promise<TActor | null>;
  /** Look up a cached actor by its `publicKey.id` (HTTP-signature key resolution). */
  findActorByPublicKeyId(keyId: string): Promise<Pick<TActor, 'uri' | 'publicKeyPem'> | null>;
  /** Stamp the resolved Oxy user id onto an actor row (identified by its `_id`). */
  setActorOxyUserId(actorId: unknown, oxyUserId: string): Promise<void>;
  /**
   * Tombstone a permanently-gone actor (mark it suspended) and return its linked
   * Oxy user id (or null when no row matched).
   */
  tombstoneActor(uri: string): Promise<{ oxyUserId?: string | null } | null>;
}

/** The identity-bridge subset the actor resolver depends on. */
export interface ActorResolverIdentity {
  resolveExternalUser(
    actor: NormalizedExternalActor,
    opts?: { forceAvatarRefresh?: boolean },
  ): Promise<string | null>;
  reportActorGone(oxyUserId: string): Promise<ReportActorGoneOutcome>;
}

/**
 * App-supplied normalization of remote actor text. The engine owns WHICH fields
 * to read and the order; the app owns HOW to normalize (its canonical whitespace
 * normalizer + HTML sanitizer), so the engine ships no HTML/entity dependency.
 */
export interface ActorTextAdapter {
  /** One-line field (preferredUsername / name / PropertyValue name); '' for non-strings. */
  inlineField(value: unknown): string;
  /** Entity-decode + inline-normalize a display name. */
  inlineDisplayName(raw: string): string;
  /** Sanitize (safe inline markup only) + inline-normalize a PropertyValue html value. */
  sanitizeFieldValue(html: string): string;
  /** Multiline HTML → plain text (the actor bio/summary). */
  htmlToPlainText(html: string): string;
  /**
   * Qualify the bare `@handle`s an actor wrote in its own bio with the network
   * they belong to — `@openai` on an X-relabelled actor means `@openai@x.com`.
   *
   * A handle is only meaningful beside the network it was written on, and that
   * context is exactly what is lost when the text crosses over: copied verbatim,
   * `@openai` reads on the receiving server as a LOCAL name, pointing readers at
   * whoever holds it there.
   *
   * OPTIONAL, and the engine does not care whether an app supplies it: the rule
   * for what may be a handle is the app's (Mention scans with the same entity
   * scanner its composer and renderer use, so a URL's `@handle`, an email and an
   * already-qualified handle are all left alone by construction). An app that
   * omits it gets the previous behaviour exactly.
   *
   * Applied ONCE, where the bio is settled — so the stored actor row and the Oxy
   * profile cannot disagree, and no renderer is left to re-derive it.
   */
  qualifyHandles?(text: string, instanceDomain: string): string;
}

/** A parsed WebFinger JRD (only the `links` we read). */
export interface WebFingerJrd {
  links?: Array<{ rel?: string; type?: string; href?: string }>;
}

/**
 * SSRF-safe bounded WebFinger fetch: GET the JRD URL and return the parsed JSON,
 * or `null` on a non-2xx response. MAY throw on a network / parse / size-limit
 * failure — the resolver catches it and treats the resolution as failed.
 */
export type WebFingerFetch = (url: string) => Promise<WebFingerJrd | null>;

/** Minimal logging sink the actor resolver writes to. */
export interface ActorResolverLogger {
  info(message: string): void;
  warn(message: string, detail?: unknown): void;
}

/** Adapters + config an {@link ActorResolver} is built from. */
export interface ActorResolverConfig<TActor extends FederatedActorRecordBase> {
  /** Whether federation is enabled (gates background refreshes). */
  federationEnabled: boolean;
  /** Signed AP GET (actor + collection-count fetches). */
  signedFetch: SignedFetch;
  /** SSRF-safe bounded WebFinger fetch. */
  fetchWebFinger: WebFingerFetch;
  /** Per-instance blocked-domain check (own domains + identity apex + configured blocks). */
  isBlockedDomain: (domain: string) => boolean;
  /** Canonicalize a fediverse acct (`user@domain`), or undefined when invalid. */
  normalizeFederatedAcct: (acct: string | undefined) => string | undefined;
  /** Extract the domain from a canonical acct. */
  domainFromAcct: (acct: string) => string | undefined;
  /** Recursively find the first absolute http(s) URL in a value (icon/image). */
  firstStringUrl: (value: unknown) => string | undefined;
  /**
   * Optional re-labelling of a bridged actor onto its real network. Absent means
   * every actor keeps the identity of the host it was fetched from.
   */
  deriveNetworkIdentity?: DeriveNetworkIdentity;
  /** The app's actor cache store. */
  store: FederatedActorStore<TActor>;
  /** The actor↔Oxy-user identity bridge. */
  identity: ActorResolverIdentity;
  /** Remote-text normalization. */
  text: ActorTextAdapter;
  /** Diagnostics sink. */
  logger: ActorResolverLogger;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function sameOriginUrl(a: string, b: string): boolean {
  try {
    const urlA = new URL(a);
    const urlB = new URL(b);
    return urlA.protocol === urlB.protocol
      && urlA.port === urlB.port
      && isSameFederationHost(urlA.hostname, urlB.hostname);
  } catch {
    return false;
  }
}

function actorPublicKeyIsSelfConsistent(actor: Record<string, unknown>, actorId: string): boolean {
  const publicKey = asRecord(actor.publicKey);
  if (!publicKey) return true;

  const publicKeyId = asString(publicKey.id);
  if (publicKeyId && !sameOriginUrl(publicKeyId, actorId)) return false;

  const owner = asString(publicKey.owner);
  if (owner && owner !== actorId) return false;

  return true;
}

/**
 * Resolution, caching and refresh of remote ActivityPub actors, over app-provided
 * storage + identity + transports. A class so that internal cross-calls dispatch
 * through the instance (e.g. `fetchRemoteActor` → `this.tombstoneGoneActor`),
 * which keeps them spy-able and overridable in tests.
 */
export class ActorResolver<TActor extends FederatedActorRecordBase> {
  /** Actor URIs with an in-flight background refresh (guards against refresh storms). */
  private readonly inFlightActorRefreshes = new Set<string>();

  constructor(private readonly config: ActorResolverConfig<TActor>) {}

  /**
   * Whether an actor URI's host is refused by the instance domain policy. An
   * unparseable URI has no host to check, so it is refused too — the policy is a
   * safety gate and fails closed rather than letting a malformed URI slip past it.
   */
  private isBlockedActorUri(actorUri: string): boolean {
    let host: string;
    try {
      host = new URL(actorUri).hostname.toLowerCase();
    } catch {
      return true;
    }
    return this.config.isBlockedDomain(host);
  }

  private acctMatchesActorHost(acct: string | undefined, actorHost: string): acct is string {
    if (!acct) return false;
    const domain = this.config.domainFromAcct(acct);
    if (!domain) return false;
    return isSameFederationHost(domain, actorHost);
  }

  /**
   * Resolve a WebFinger acct to an ActivityPub actor URI.
   * @param acct - e.g. "alice@mastodon.social" or "@alice@mastodon.social"
   */
  async resolveWebFinger(acct: string): Promise<string | null> {
    const cleaned = this.config.normalizeFederatedAcct(acct);
    if (!cleaned) return null;

    const domain = this.config.domainFromAcct(cleaned);
    if (!domain) return null;
    if (this.config.isBlockedDomain(domain)) return null;

    const resource = `acct:${cleaned}`;
    const url = `https://${domain}/.well-known/webfinger?resource=${encodeURIComponent(resource)}`;

    try {
      const data = await this.config.fetchWebFinger(url);
      if (!data) return null;
      const link = data.links?.find(
        (l) => l.rel === 'self' && isApActorContentType(l.type),
      );
      return link?.href || null;
    } catch (err) {
      this.config.logger.warn(`WebFinger resolution failed for ${acct}:`, err);
      return null;
    }
  }

  /**
   * Fetch and store/update a remote ActivityPub actor by URI.
   *
   * @param actorUri - the remote actor URI to fetch.
   * @param forceAvatarRefresh - when true, tell Oxy's `PUT /users/resolve` to
   *   re-download and replace the federated avatar even if it already has a stored
   *   file ID. Pass `true` from refresh paths and `false` for first-time creation.
   */
  async fetchRemoteActor(
    actorUri: string,
    forceAvatarRefresh = false,
    acctHint?: string,
  ): Promise<TActor | null> {
    // A WebFinger fallback may resolve the stored URI to a different canonical one;
    // track that here rather than reassigning the parameter (the stored row is
    // keyed by the fetched `actor.id`, so a redirect only affects log context).
    let currentUri = actorUri;
    try {
      // Reject our own/blocked domains before any network I/O. A malformed URI
      // throws here and is handled by the catch below.
      const requestedHost = new URL(currentUri).hostname.toLowerCase();
      if (this.config.isBlockedDomain(requestedHost)) {
        this.config.logger.info(`[FedSync] fetchRemoteActor skipping own/blocked domain ${requestedHost} for ${currentUri}`);
        return null;
      }

      const canonicalAcctHint = this.config.normalizeFederatedAcct(acctHint);
      // Use signed fetch for servers that enforce authorized fetch (e.g., Threads)
      let res = await this.config.signedFetch(currentUri, AP_CONTENT_TYPE);
      if (!res.ok) {
        // A definitive 410 Gone is authoritative: tombstone and stop — do NOT fall
        // through to the WebFinger fallback (which recovers a STALE/wrong URI on a
        // transient failure, not a permanent removal). Only 410 does this.
        if (res.status === 410) {
          this.config.logger.info(`[FedSync] fetchRemoteActor 410 Gone for ${currentUri} — tombstoning actor`);
          await this.tombstoneGoneActor(currentUri);
          return null;
        }
        const body = await readBoundedResponseBody(res, ERROR_BODY_MAX_BYTES).catch(() => '');
        this.config.logger.info(`[FedSync] fetchRemoteActor HTTP ${res.status} ${res.statusText} for ${currentUri} body=${body.slice(0, 500)}`);

        // If direct fetch failed, try WebFinger to resolve the canonical actor URI.
        // Some servers (e.g., Threads) use numeric IDs in AP URIs that differ from
        // the username-based URI we may have stored.
        const parsed = new URL(currentUri);
        const pathUsername = parsed.pathname.split('/').filter(Boolean).pop();
        const acct = canonicalAcctHint
          || (pathUsername ? this.config.normalizeFederatedAcct(`${pathUsername}@${parsed.hostname}`) : undefined);
        if (acct) {
          this.config.logger.info(`[FedSync] attempting WebFinger fallback for ${acct}`);
          const resolved = await this.resolveWebFinger(acct);
          if (resolved && resolved !== currentUri) {
            this.config.logger.info(`[FedSync] WebFinger resolved ${acct} → ${resolved}`);
            res = await this.config.signedFetch(resolved, AP_CONTENT_TYPE);
            if (res.ok) {
              currentUri = resolved;
            } else {
              // A 410 on the WebFinger-RESOLVED URI is just as definitive. Tombstone
              // against the stored URI (not reassigned on this branch).
              if (res.status === 410) {
                this.config.logger.info(`[FedSync] fetchRemoteActor 410 Gone for resolved ${resolved} — tombstoning actor ${currentUri}`);
                await this.tombstoneGoneActor(currentUri);
                return null;
              }
              const body2 = await readBoundedResponseBody(res, ERROR_BODY_MAX_BYTES).catch(() => '');
              this.config.logger.info(`[FedSync] fetchRemoteActor HTTP ${res.status} for resolved ${resolved} body=${body2.slice(0, 500)}`);
              return null;
            }
          } else {
            this.config.logger.info(`[FedSync] WebFinger returned ${resolved ?? 'null'} for ${acct}`);
            return null;
          }
        } else {
          return null;
        }
      }

      const actor = await readBoundedJson(res, ACTOR_BODY_MAX_BYTES);
      const actorId = asString(actor.id);
      const actorInbox = asString(actor.inbox);
      if (!actorId || !actorInbox) {
        this.config.logger.info(`[FedSync] fetchRemoteActor missing fields for ${currentUri}: id=${!!actor.id} inbox=${!!actor.inbox} type=${String(actor.type)} keys=${Object.keys(actor).join(',')}`);
        return null;
      }

      if (!sameOriginUrl(currentUri, actorId)) {
        this.config.logger.warn(`[FedSync] rejecting actor ${currentUri}: fetched URI is not authoritative for claimed id ${actorId}`);
        return null;
      }

      if (!actorPublicKeyIsSelfConsistent(actor, actorId)) {
        this.config.logger.warn(`[FedSync] rejecting actor ${currentUri}: publicKey is not self-consistent for claimed id ${actorId}`);
        return null;
      }

      const actorHost = new URL(actorId).hostname.toLowerCase();
      const username = this.config.text.inlineField(actor.preferredUsername)
        || this.config.text.inlineField(actor.name)
        || 'unknown';
      const actorWebfinger = typeof actor.webfinger === 'string'
        ? this.config.normalizeFederatedAcct(actor.webfinger)
        : undefined;
      const verifiedAcctHint = this.acctMatchesActorHost(canonicalAcctHint, actorHost)
        ? canonicalAcctHint
        : undefined;
      const verifiedActorWebfinger = this.acctMatchesActorHost(actorWebfinger, actorHost)
        ? actorWebfinger
        : undefined;
      const acct = verifiedAcctHint
        || verifiedActorWebfinger
        || this.config.normalizeFederatedAcct(`${username}@${actorHost}`)
        || `${username.toLowerCase()}@${actorHost}`;
      const domain = this.config.domainFromAcct(acct) || actorHost;
      // Re-check against the RESOLVED host/acct (post-redirect / WebFinger), which
      // can differ from the originally-requested URI host the early guard screened.
      if (this.config.isBlockedDomain(domain) || this.config.isBlockedDomain(actorHost)) {
        this.config.logger.info(`[FedSync] fetchRemoteActor blocked domain ${domain} actorHost=${actorHost} for ${currentUri}`);
        return null;
      }

      const actorEndpoints = asRecord(actor.endpoints);
      const actorPublicKey = asRecord(actor.publicKey);

      // Fetch collection counts (followers, following, posts) in parallel
      const [followersCount, followingCount, postsCount] = await Promise.all([
        this.fetchCollectionCount(asString(actor.followers)),
        this.fetchCollectionCount(asString(actor.following)),
        this.fetchCollectionCount(asString(actor.outbox)),
      ]);

      // Extract profile fields (PropertyValue attachments). Sanitize BEFORE
      // normalizing: the canonical normalizer collapses whitespace, it never
      // strips markup — so the sanitizer must run first, on the raw value.
      const fields: FederatedActorField[] = [];
      if (Array.isArray(actor.attachment)) {
        for (const att of actor.attachment) {
          const attRecord = asRecord(att);
          if (!attRecord || attRecord.type !== 'PropertyValue') continue;
          const fieldName = this.config.text.inlineField(attRecord.name);
          const fieldValue = typeof attRecord.value === 'string'
            ? this.config.text.sanitizeFieldValue(attRecord.value)
            : '';
          if (!fieldName || !fieldValue) continue;
          fields.push({
            name: fieldName,
            value: fieldValue,
            verifiedAt: attRecord.verifiedAt ? new Date(String(attRecord.verifiedAt)) : undefined,
          });
        }
      }

      const avatarUrl = this.config.firstStringUrl(actor.icon);
      const headerUrl = this.config.firstStringUrl(actor.image);
      // `summary` is the actor's bio — a BODY, so its line breaks are the author's
      // and must survive; `htmlToPlainText` normalizes it as multiline.
      const summary = typeof actor.summary === 'string' ? this.config.text.htmlToPlainText(actor.summary) : '';
      // The display name is one line. Entity-decode FIRST (an encoded `&#10;` or
      // `&nbsp;` only becomes whitespace once decoded), THEN collapse.
      const rawDisplayName = typeof actor.name === 'string' ? actor.name : '';
      const displayName = this.config.text.inlineDisplayName(rawDisplayName) || username;

      const alsoKnownAs = Array.isArray(actor.alsoKnownAs)
        ? actor.alsoKnownAs.filter((v): v is string => typeof v === 'string')
        : undefined;

      // The IDENTITY the actor is stored under in Oxy, which is not necessarily the
      // host it was fetched from — see `DeriveNetworkIdentity`. Everything below
      // that addresses the actor over the PROTOCOL (`acct`, `uri`, `domain`) is
      // deliberately left alone.
      const networkIdentity = this.resolveNetworkIdentity({
        host: actorHost,
        acct,
        preferredUsername: username,
        actorUri: actorId,
        actorType: asString(actor.type) || 'Person',
        alsoKnownAs: alsoKnownAs ?? [],
        fields,
        // FEP-fffd: an actor's own machine-readable statement of what it proxies.
        // Parsed here so a derivation rule never re-reads the raw document — and
        // deliberately only ever CONSULTED by a reviewed entry, since every field
        // in it is asserted by the untrusted actor itself.
        proxyOf: readProxyDeclarations(actor.proxyOf),
        bio: summary,
      });
      const identityUsername = networkIdentity?.federatedUsername ?? acct;
      const identityDomain = networkIdentity?.instanceDomain ?? domain;
      // Qualified HERE, at the one point both writes below read from: the stored
      // row's `summary` and the Oxy profile's `bio` are the same value, so they
      // cannot drift into disagreeing about what the actor said.
      const resolvedBio = networkIdentity?.bio ?? summary;
      const identityBio = this.config.text.qualifyHandles
        ? this.config.text.qualifyHandles(resolvedBio, identityDomain)
        : resolvedBio;

      const update: FederatedActorUpsert = {
        protocol: 'activitypub',
        uri: actorId,
        username,
        domain,
        acct,
        summary: identityBio,
        avatarUrl,
        headerUrl,
        inboxUrl: actorInbox,
        outboxUrl: asString(actor.outbox) || undefined,
        sharedInboxUrl: asString(actorEndpoints?.sharedInbox) || undefined,
        followersUrl: asString(actor.followers) || undefined,
        followingUrl: asString(actor.following) || undefined,
        publicKeyPem: asString(actorPublicKey?.publicKeyPem) || undefined,
        publicKeyId: asString(actorPublicKey?.id) || undefined,
        type: asString(actor.type) || 'Person',
        manuallyApprovesFollowers: actor.manuallyApprovesFollowers === true,
        discoverable: actor.discoverable !== false,
        memorial: actor.memorial === true,
        suspended: actor.suspended === true,
        fields,
        featuredUrl: asString(actor.featured) || undefined,
        featuredTagsUrl: asString(actor.featuredTags) || undefined,
        alsoKnownAs,
        networkAcct: networkIdentity?.federatedUsername,
        remoteCreatedAt: typeof actor.published === 'string' ? new Date(actor.published) : undefined,
        followersCount,
        followingCount,
        postsCount,
        lastFetchedAt: new Date(),
      };

      const fedActor = await this.config.store.upsertActor(actorId, update);

      // Always upsert into Oxy so profile changes (avatar, name, bio) are synced.
      // The identity bridge creates the federated Oxy user if it does not exist,
      // updates it when changed, and mirrors the banner. This connector then stamps
      // its own actor row with the resolved id.
      if (fedActor) {
        try {
          const normalized: NormalizedExternalActor = {
            network: 'activitypub',
            externalId: actorId,
            handle: acct,
            // For an ordinary AP actor the acct IS the canonical `user@domain` Oxy
            // username and `domain` is its instance host — both verified above. For
            // a BRIDGED actor these two carry the re-labelled network identity
            // instead, while `handle` above stays the protocol address.
            federatedUsername: identityUsername,
            instanceDomain: identityDomain,
            displayName,
            avatarUrl,
            bannerUrl: headerUrl,
            // Sent even when EMPTY, and that is the whole point. oxy-api writes
            // this field only when it receives a string, so omitting it means
            // "keep whatever you already stored" — which is exactly wrong for the
            // two ways a bio legitimately becomes empty: a bridged actor whose
            // bio was nothing but the bridge's boilerplate (stripped above), and
            // any actor who simply deleted theirs upstream. Coalescing the empty
            // string away made both of those unrepresentable, so the stale text
            // survived every later refresh with nothing in the logs.
            bio: identityBio,
            followersCount,
            followingCount,
            postsCount,
            oxyUserId: fedActor.oxyUserId ?? undefined,
          };
          const oxyId = await this.config.identity.resolveExternalUser(normalized, { forceAvatarRefresh });
          if (oxyId && fedActor.oxyUserId !== oxyId && fedActor._id != null) {
            await this.config.store.setActorOxyUserId(fedActor._id, oxyId);
          }
        } catch (resolveErr) {
          this.config.logger.warn(`Failed to resolve Oxy user for ${currentUri}:`, resolveErr);
        }
      }

      return fedActor;
    } catch (err) {
      this.config.logger.warn(`Failed to fetch remote actor ${currentUri}:`, err);
      return null;
    }
  }

  /**
   * Run the app's {@link DeriveNetworkIdentity} hook and REFUSE any result the
   * identity bridge could not bind.
   *
   * oxy-api binds a federated username to its domain, so a `federatedUsername`
   * that does not end with `@${instanceDomain}` would be rejected downstream — or
   * worse, mint an identity under a domain it does not name. Validating here means
   * no app can produce that shape, and a hook that gets it wrong degrades to the
   * actor's real protocol acct (the pre-hook behaviour) instead of losing the
   * actor. The refusal is logged: it is a bug in the app's rule, not a normal
   * outcome, and it must not pass silently.
   */
  private resolveNetworkIdentity(
    candidate: NetworkIdentityCandidate,
  ): NetworkIdentity | undefined {
    const derived = this.config.deriveNetworkIdentity?.(candidate);
    if (!derived) return undefined;

    const domain = derived.instanceDomain.trim().toLowerCase();
    const federatedUsername = derived.federatedUsername.trim().toLowerCase();
    // Everything before the FIRST `@` is the local part; the whole value must then
    // be exactly `<local>@<domain>`. Stated as one equality rather than a list of
    // separate shape checks, so a value that is malformed in a way nobody thought
    // of — a second `@`, a missing one, a different separator — fails by default
    // instead of needing its own clause.
    const atIndex = federatedUsername.indexOf('@');
    const localPart = atIndex > 0 ? federatedUsername.slice(0, atIndex) : '';
    if (
      domain.length === 0
      || localPart.length === 0
      || federatedUsername !== `${localPart}@${domain}`
    ) {
      this.config.logger.warn(
        `[FedSync] refusing network identity for ${candidate.actorUri}: `
        + `"${derived.federatedUsername}" is not bindable to domain "${derived.instanceDomain}"`,
      );
      return undefined;
    }

    return { federatedUsername, instanceDomain: domain, bio: derived.bio };
  }

  /**
   * Tombstone a remote actor that returned a definitive 410 Gone. Marks the stored
   * actor suspended (via the store) and, when it links to an Oxy identity, asks
   * oxy-api to archive it so it drops out of search.
   *
   * Best-effort and fail-soft: neither the store write nor the Oxy archive call is
   * allowed to throw out of the caller. Idempotent.
   */
  async tombstoneGoneActor(actorUri: string): Promise<void> {
    try {
      const actor = await this.config.store.tombstoneActor(actorUri);
      if (!actor) {
        this.config.logger.info(`[FedSync] 410 Gone for ${actorUri} — no stored actor row to tombstone`);
        return;
      }

      this.config.logger.info(`[FedSync] tombstoned gone actor ${actorUri} (suspended)`);

      if (actor.oxyUserId) {
        const outcome = await this.config.identity.reportActorGone(actor.oxyUserId);
        this.config.logger.info(`[FedSync] actor-gone report for ${actorUri} (oxyUserId ${actor.oxyUserId}) → ${outcome}`);
      }
    } catch (err) {
      this.config.logger.warn(`[FedSync] failed to tombstone gone actor ${actorUri}:`, err);
    }
  }

  /** Fetch the totalItems count from an ActivityPub collection URL. */
  private async fetchCollectionCount(url?: string): Promise<number> {
    if (!url) return 0;
    try {
      const res = await this.config.signedFetch(url, AP_CONTENT_TYPE);
      if (!res.ok) return 0;
      const col = await readBoundedJson(res, COLLECTION_BODY_MAX_BYTES);
      return typeof col.totalItems === 'number' ? col.totalItems : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Get a cached actor or fetch if missing/stale (>24h).
   *
   * Never blocks on remote network I/O when a cached actor already exists: a stale
   * cached actor is returned immediately and a background refresh is enqueued. Only
   * a completely missing actor triggers a blocking fetch.
   */
  async getOrFetchActor(actorUri: string): Promise<TActor | null> {
    // The domain policy governs BOTH branches below, not just the fetching one.
    // `fetchRemoteActor` refuses a blocked host, but the cache hit above it used to
    // return early — so for any instance we had ever stored an actor for (i.e. every
    // instance that has ever reached us), blocking its domain changed nothing. That
    // made the blocklist inert for exactly the hosts it is added for.
    if (this.isBlockedActorUri(actorUri)) {
      this.config.logger.info(`[FedSync] getOrFetchActor refusing own/blocked domain for ${actorUri}`);
      return null;
    }
    const existing = await this.config.store.findActorByUri(actorUri);
    if (existing) {
      const isStale = !existing.lastFetchedAt || Date.now() - existing.lastFetchedAt.getTime() > ACTOR_STALE_MS;
      if (isStale) {
        // Refresh in the background — never block the caller on remote I/O.
        this.refreshActorInBackground(actorUri, existing);
      }
      return existing;
    }
    return this.fetchRemoteActor(actorUri);
  }

  /**
   * Enqueue a fire-and-forget full-actor refresh. Safe to call on a client request
   * path: it returns synchronously and the fetch runs detached. Guards against
   * refresh storms (in-flight dedup + a recency skip unless the profile is
   * incomplete). The avatar refresh is forced only when the actor already exists.
   */
  refreshActorInBackground(actorUri: string, existing?: TActor): void {
    if (!this.config.federationEnabled) return;
    if (this.inFlightActorRefreshes.has(actorUri)) return;

    const missingProfile = !existing || !existing.avatarUrl || !existing.headerUrl;
    const lastFetchedMs = existing?.lastFetchedAt?.getTime();
    const refreshedRecently = typeof lastFetchedMs === 'number'
      && Date.now() - lastFetchedMs < ACTOR_REFRESH_MIN_INTERVAL_MS;

    // Skip if we refreshed recently AND the cached profile is already complete.
    if (refreshedRecently && !missingProfile) return;

    // Force avatar re-download only when the actor already exists (refresh).
    const forceAvatarRefresh = Boolean(existing);

    this.inFlightActorRefreshes.add(actorUri);
    void (async () => {
      try {
        await this.fetchRemoteActor(actorUri, forceAvatarRefresh, existing?.acct);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.config.logger.warn(`[FedSync] background actor refresh failed for ${actorUri}: ${message}`);
      } finally {
        this.inFlightActorRefreshes.delete(actorUri);
      }
    })();
  }

  /**
   * Resolve a remote actor URI to its listable Oxy user id. Returns null when the
   * actor cannot be resolved to an Oxy user — callers must then skip.
   */
  async resolveActorOxyUserId(actorUri: string): Promise<string | null> {
    const actor = await this.getOrFetchActor(actorUri);
    return actor?.oxyUserId ?? null;
  }

  /**
   * Fetch a public key by keyId (used for HTTP signature verification).
   *
   * Deliberately NOT domain-policy gated on the cached branch: this answers "what
   * key signs for this keyId", a question about authenticity, not about whether we
   * federate with the answer. Suspending an instance is enforced where the activity
   * is dispatched (`createInboundDispatcher`), so a blocked instance's signature is
   * still evaluated honestly and its activity is then dropped as policy, rather
   * than being reported as a forged signature. The uncached branch still refuses,
   * because resolving it would mean network I/O toward a blocked host.
   */
  async fetchPublicKey(keyId: string): Promise<{ publicKeyPem: string; actorUri: string } | null> {
    // keyId is typically the actor URI with #main-key appended
    const actorUri = keyId.replace(/#.*$/, '');

    // Check local cache first
    const cached = await this.config.store.findActorByPublicKeyId(keyId);
    if (cached?.publicKeyPem) {
      return { publicKeyPem: cached.publicKeyPem, actorUri: cached.uri };
    }

    // Fetch the actor to get the public key (uses 24h cache)
    const actor = await this.getOrFetchActor(actorUri);
    if (!actor?.publicKeyPem) return null;

    return { publicKeyPem: actor.publicKeyPem, actorUri: actor.uri };
  }
}

/** Build the remote-actor resolver from an app's storage + identity + transports. */
export function createActorResolver<TActor extends FederatedActorRecordBase>(
  config: ActorResolverConfig<TActor>,
): ActorResolver<TActor> {
  return new ActorResolver(config);
}
