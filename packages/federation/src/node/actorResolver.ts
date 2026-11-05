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
import { apDate, apImageUrl, apIri, apIriList, apList, isActivityPubMediaType } from '../apValue';
import {
  readProxyDeclarations,
  type DeriveNetworkIdentity,
  type NetworkIdentity,
  type NetworkIdentityCandidate,
} from '../networkIdentity';
import type { NormalizedExternalActor } from '../index';
import { readBoundedResponseJson, readBoundedResponseText } from './boundedBody';
import type { SignedFetch } from './signedFetch';
import type { ReportActorGoneOutcome } from './identityBridge';
import type { FetchPublicKeyOptions } from '../httpSignature';

/**
 * Minimum interval between background actor refreshes for the same actor.
 * Prevents refresh storms when a profile is viewed repeatedly in a short window.
 */
const ACTOR_REFRESH_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

/** Staleness threshold after which a cached actor is eligible for a background re-fetch. */
const ACTOR_STALE_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * How recently fetched an actor must be for its stored key to count as current
 * when a signature fails against it. An actor fetched this recently is not
 * fetched again: the key that failed is the one it publishes, and anyone can
 * send a bad signature naming a real actor's keyId.
 */
const KEY_REFETCH_MIN_INTERVAL_MS = 60 * 1000; // 1 minute

/** The AP content type asked for on signed actor/collection fetches. */
const AP_CONTENT_TYPE = 'application/activity+json';

/** Maximum decompressed response sizes accepted from untrusted federation hosts. */
const ACTOR_BODY_MAX_BYTES = 1024 * 1024;
const COLLECTION_BODY_MAX_BYTES = 64 * 1024;
/**
 * Collection responses that DEFINITIVELY withhold the count: the owner hid the
 * collection (401/403) or it no longer exists (404/410). Anything else non-2xx
 * is a failed attempt, not an answer.
 */
const COLLECTION_WITHHELD_STATUSES: ReadonlySet<number> = new Set([401, 403, 404, 410]);
const ERROR_BODY_MAX_BYTES = 4 * 1024;

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
  /**
   * Mastodon's opt-in to search engines and full-text search (`indexable`).
   * Absent when the actor does not say, which Mastodon reads as "no".
   */
  indexable?: boolean;
  memorial: boolean;
  suspended: boolean;
  fields: FederatedActorField[];
  featuredUrl?: string;
  featuredTagsUrl?: string;
  alsoKnownAs?: string[];
  /** The account this actor moved to (`movedTo`), when it advertises one. */
  movedTo?: string;
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
  /**
   * The remote's own totals for its `followers`, `following` and `outbox`
   * collections, read from each collection's `totalItems`. Each is a
   * {@link CollectionCount}, and the three states mean three different writes:
   *
   * - a number — the remote reported it; store it. `0` is a real zero.
   * - `null` — the remote definitively does not disclose it (no collection
   *   advertised, a hidden collection answering 401/403, a gone one answering
   *   404/410, or a collection that carries no numeric `totalItems`). Store it
   *   as UNKNOWN — never as `0`.
   * - absent (`undefined`) — this refresh could not tell (a timeout, a network
   *   error, a 429/5xx, an unreadable body). The store must LEAVE the stored
   *   value in place, and a first insert must record it as unknown.
   */
  followersCount?: number | null;
  followingCount?: number | null;
  postsCount?: number | null;
  lastFetchedAt: Date;
}

/**
 * A remote collection's size as one refresh observed it: the reported
 * `totalItems`, `null` when the remote definitively withholds it, or `undefined`
 * when this attempt could not find out. See {@link FederatedActorUpsert.followersCount}.
 */
export type CollectionCount = number | null | undefined;

/** Bring-your-own-store: the AP actor cache stays in the app DB behind this adapter. */
export interface FederatedActorStore<TActor extends FederatedActorRecordBase, TSource = undefined> {
  /** Look up a cached actor by its protocol URI. */
  findActorByUri(uri: string): Promise<TActor | null>;
  /**
   * Upsert (create-or-update) the actor cache row keyed by `uri`. `source` is
   * what {@link ActorResolverConfig.fetchActorDocument} returned beside the
   * document this update was parsed from (absent with the default fetch).
   */
  upsertActor(uri: string, update: FederatedActorUpsert, source?: TSource): Promise<TActor | null>;
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

/**
 * One read of a remote actor document, as {@link ActorResolver.fetchRemoteActor}
 * consumes it.
 */
export interface ActorDocumentFetchResult<TSource = undefined> {
  /** The HTTP status the actor's server answered. Only a 2xx carries `document`. */
  status: number;
  /** The actor document, present when the read succeeded. */
  document?: Record<string, unknown>;
  /** A short description of a failure for the resolver's log line. */
  detail?: string;
  /**
   * What the fetcher learned beside the document (Mention: Oxy's verified
   * identity answer), handed to {@link FederatedActorStore.upsertActor} so the
   * store does not ask for it a second time.
   */
  source?: TSource;
}

/**
 * Where actor documents come from: the actor URI, and the canonical acct the
 * caller knows it by (a hint, never an identity claim).
 */
export type ActorDocumentFetch<TSource = undefined> = (
  actorUri: string,
  acctHint?: string,
) => Promise<ActorDocumentFetchResult<TSource>>;

/** Whether a read produced a document the resolver can parse. */
function hasActorDocument<TSource>(
  fetched: ActorDocumentFetchResult<TSource>,
): fetched is ActorDocumentFetchResult<TSource> & { document: Record<string, unknown> } {
  return fetched.status >= 200 && fetched.status < 300 && fetched.document !== undefined;
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
export interface ActorResolverConfig<TActor extends FederatedActorRecordBase, TSource = undefined> {
  /** Whether federation is enabled (gates background refreshes). */
  federationEnabled: boolean;
  /** Signed AP GET (collection-count fetches, and actor documents by default). */
  signedFetch: SignedFetch;
  /**
   * Where actor documents come from. Default: {@link signedFetch} of the actor
   * URI. An app whose identity authority already fetches and verifies the actor
   * reads the document from that answer instead, so one refresh fetches the
   * actor once: Mention reads it from Oxy's `/federation/identities/resolve`,
   * which returns the document it verified. Every guard below (same origin,
   * self-consistent key, blocked domains, 410 tombstone, WebFinger fallback)
   * applies to the document whichever way it arrived.
   */
  fetchActorDocument?: ActorDocumentFetch<TSource>;
  /** SSRF-safe bounded WebFinger fetch. */
  fetchWebFinger: WebFingerFetch;
  /** Per-instance blocked-domain check (own domains + identity apex + configured blocks). */
  isBlockedDomain: (domain: string) => boolean;
  /** Canonicalize a fediverse acct (`user@domain`), or undefined when invalid. */
  normalizeFederatedAcct: (acct: string | undefined) => string | undefined;
  /** Extract the domain from a canonical acct. */
  domainFromAcct: (acct: string) => string | undefined;
  /**
   * The first absolute http(s) URL in an `icon` / `image` value. Optional: the
   * default is {@link apImageUrl}, which reads every image shape.
   */
  firstStringUrl?: (value: unknown) => string | undefined;
  /**
   * Optional re-labelling of a bridged actor onto its real network. Absent means
   * every actor keeps the identity of the host it was fetched from.
   */
  deriveNetworkIdentity?: DeriveNetworkIdentity;
  /** The app's actor cache store. */
  store: FederatedActorStore<TActor, TSource>;
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
    return (
      urlA.protocol === urlB.protocol &&
      urlA.port === urlB.port &&
      isSameFederationHost(urlA.hostname, urlB.hostname)
    );
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
export class ActorResolver<TActor extends FederatedActorRecordBase, TSource = undefined> {
  /** Actor URIs with an in-flight background refresh (guards against refresh storms). */
  private readonly inFlightActorRefreshes = new Set<string>();

  /** Actor key refetches in flight, by actor URI: concurrent failed signatures share one. */
  private readonly inFlightKeyRefetches = new Map<string, Promise<TActor | null>>();

  constructor(private readonly config: ActorResolverConfig<TActor, TSource>) {}

  /** One read of an actor document: the app's {@link ActorResolverConfig.fetchActorDocument}, or a signed GET. */
  private async readActorDocument(
    actorUri: string,
    acctHint?: string,
  ): Promise<ActorDocumentFetchResult<TSource>> {
    if (this.config.fetchActorDocument) return this.config.fetchActorDocument(actorUri, acctHint);
    const res = await this.config.signedFetch(actorUri, AP_CONTENT_TYPE);
    if (res.ok) {
      return {
        status: res.status,
        document: await readBoundedResponseJson(res, { maxBytes: ACTOR_BODY_MAX_BYTES }),
      };
    }
    if (res.status === 410) return { status: res.status };
    const body = await readBoundedResponseText(res, { maxBytes: ERROR_BODY_MAX_BYTES }).catch(
      () => '',
    );
    return { status: res.status, detail: `${res.statusText} body=${body.slice(0, 500)}`.trim() };
  }

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
      const link = data.links?.find((l) => l.rel === 'self' && isActivityPubMediaType(l.type));
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
        this.config.logger.info(
          `[FedSync] fetchRemoteActor skipping own/blocked domain ${requestedHost} for ${currentUri}`,
        );
        return null;
      }

      const canonicalAcctHint = this.config.normalizeFederatedAcct(acctHint);
      let fetched = await this.readActorDocument(currentUri, canonicalAcctHint);
      if (!hasActorDocument(fetched)) {
        // A definitive 410 Gone is authoritative: tombstone and stop — do NOT fall
        // through to the WebFinger fallback (which recovers a STALE/wrong URI on a
        // transient failure, not a permanent removal). Only 410 does this.
        if (fetched.status === 410) {
          this.config.logger.info(
            `[FedSync] fetchRemoteActor 410 Gone for ${currentUri} — tombstoning actor`,
          );
          await this.tombstoneGoneActor(currentUri);
          return null;
        }
        this.config.logger.info(
          `[FedSync] fetchRemoteActor HTTP ${fetched.status}${fetched.detail ? ` ${fetched.detail}` : ''} for ${currentUri}`,
        );

        // If direct fetch failed, try WebFinger to resolve the canonical actor URI.
        // Some servers (e.g., Threads) use numeric IDs in AP URIs that differ from
        // the username-based URI we may have stored.
        const parsed = new URL(currentUri);
        const pathUsername = parsed.pathname.split('/').filter(Boolean).pop();
        const acct =
          canonicalAcctHint ||
          (pathUsername
            ? this.config.normalizeFederatedAcct(`${pathUsername}@${parsed.hostname}`)
            : undefined);
        if (!acct) return null;
        this.config.logger.info(`[FedSync] attempting WebFinger fallback for ${acct}`);
        const resolved = await this.resolveWebFinger(acct);
        if (!resolved || resolved === currentUri) {
          this.config.logger.info(`[FedSync] WebFinger returned ${resolved ?? 'null'} for ${acct}`);
          return null;
        }
        this.config.logger.info(`[FedSync] WebFinger resolved ${acct} → ${resolved}`);
        fetched = await this.readActorDocument(resolved, acct);
        if (!hasActorDocument(fetched)) {
          // A 410 on the WebFinger-RESOLVED URI is just as definitive. Tombstone
          // against the stored URI.
          if (fetched.status === 410) {
            this.config.logger.info(
              `[FedSync] fetchRemoteActor 410 Gone for resolved ${resolved} — tombstoning actor ${currentUri}`,
            );
            await this.tombstoneGoneActor(currentUri);
            return null;
          }
          this.config.logger.info(
            `[FedSync] fetchRemoteActor HTTP ${fetched.status}${fetched.detail ? ` ${fetched.detail}` : ''} for resolved ${resolved}`,
          );
          return null;
        }
        currentUri = resolved;
      }

      const actor = fetched.document;
      const actorId = asString(actor.id);
      const actorInbox = apIri(actor.inbox);
      if (!actorId || !actorInbox) {
        this.config.logger.info(
          `[FedSync] fetchRemoteActor missing fields for ${currentUri}: id=${!!actor.id} inbox=${!!actor.inbox} type=${String(actor.type)} keys=${Object.keys(actor).join(',')}`,
        );
        return null;
      }

      if (!sameOriginUrl(currentUri, actorId)) {
        this.config.logger.warn(
          `[FedSync] rejecting actor ${currentUri}: fetched URI is not authoritative for claimed id ${actorId}`,
        );
        return null;
      }

      if (!actorPublicKeyIsSelfConsistent(actor, actorId)) {
        this.config.logger.warn(
          `[FedSync] rejecting actor ${currentUri}: publicKey is not self-consistent for claimed id ${actorId}`,
        );
        return null;
      }

      const actorHost = new URL(actorId).hostname.toLowerCase();
      const username =
        this.config.text.inlineField(actor.preferredUsername) ||
        this.config.text.inlineField(actor.name) ||
        'unknown';
      const actorWebfinger =
        typeof actor.webfinger === 'string'
          ? this.config.normalizeFederatedAcct(actor.webfinger)
          : undefined;
      const verifiedAcctHint = this.acctMatchesActorHost(canonicalAcctHint, actorHost)
        ? canonicalAcctHint
        : undefined;
      const verifiedActorWebfinger = this.acctMatchesActorHost(actorWebfinger, actorHost)
        ? actorWebfinger
        : undefined;
      const acct =
        verifiedAcctHint ||
        verifiedActorWebfinger ||
        this.config.normalizeFederatedAcct(`${username}@${actorHost}`) ||
        `${username.toLowerCase()}@${actorHost}`;
      const domain = this.config.domainFromAcct(acct) || actorHost;
      // Re-check against the RESOLVED host/acct (post-redirect / WebFinger), which
      // can differ from the originally-requested URI host the early guard screened.
      if (this.config.isBlockedDomain(domain) || this.config.isBlockedDomain(actorHost)) {
        this.config.logger.info(
          `[FedSync] fetchRemoteActor blocked domain ${domain} actorHost=${actorHost} for ${currentUri}`,
        );
        return null;
      }

      const actorEndpoints = asRecord(actor.endpoints);
      const actorPublicKey = asRecord(actor.publicKey);

      // Fetch collection counts (followers, following, posts) in parallel
      const [followersCount, followingCount, postsCount] = await Promise.all([
        this.fetchCollectionCount(apIri(actor.followers)),
        this.fetchCollectionCount(apIri(actor.following)),
        this.fetchCollectionCount(apIri(actor.outbox)),
      ]);

      // Extract profile fields (PropertyValue attachments). Sanitize BEFORE
      // normalizing: the canonical normalizer collapses whitespace, it never
      // strips markup — so the sanitizer must run first, on the raw value.
      const fields: FederatedActorField[] = [];
      for (const att of apList(actor.attachment)) {
        const attRecord = asRecord(att);
        if (!attRecord || attRecord.type !== 'PropertyValue') continue;
        const fieldName = this.config.text.inlineField(attRecord.name);
        const fieldValue =
          typeof attRecord.value === 'string'
            ? this.config.text.sanitizeFieldValue(attRecord.value)
            : '';
        if (!fieldName || !fieldValue) continue;
        fields.push({
          name: fieldName,
          value: fieldValue,
          verifiedAt: apDate(attRecord.verifiedAt),
        });
      }

      const imageUrl = this.config.firstStringUrl ?? apImageUrl;
      const avatarUrl = imageUrl(actor.icon);
      const headerUrl = imageUrl(actor.image);
      // `summary` is the actor's bio — a BODY, so its line breaks are the author's
      // and must survive; `htmlToPlainText` normalizes it as multiline.
      const summary =
        typeof actor.summary === 'string' ? this.config.text.htmlToPlainText(actor.summary) : '';
      // The display name is one line. Entity-decode FIRST (an encoded `&#10;` or
      // `&nbsp;` only becomes whitespace once decoded), THEN collapse.
      const rawDisplayName = typeof actor.name === 'string' ? actor.name : '';
      const displayName = this.config.text.inlineDisplayName(rawDisplayName) || username;

      // Absent stays absent (the store keeps what it has); one alias or a list
      // of them is the list.
      const alsoKnownAs =
        actor.alsoKnownAs === undefined || actor.alsoKnownAs === null
          ? undefined
          : apIriList(actor.alsoKnownAs);
      // A move target is an actor URL; anything else is not one.
      const movedToValue = apIri(actor.movedTo);
      const movedTo = movedToValue && /^https?:\/\//.test(movedToValue) ? movedToValue : undefined;

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
        outboxUrl: apIri(actor.outbox),
        sharedInboxUrl: apIri(actorEndpoints?.sharedInbox),
        followersUrl: apIri(actor.followers),
        followingUrl: apIri(actor.following),
        publicKeyPem: asString(actorPublicKey?.publicKeyPem) || undefined,
        publicKeyId: asString(actorPublicKey?.id) || undefined,
        type: asString(actor.type) || 'Person',
        manuallyApprovesFollowers: actor.manuallyApprovesFollowers === true,
        discoverable: actor.discoverable !== false,
        ...(typeof actor.indexable === 'boolean' && { indexable: actor.indexable }),
        memorial: actor.memorial === true,
        suspended: actor.suspended === true,
        fields,
        featuredUrl: apIri(actor.featured),
        featuredTagsUrl: apIri(actor.featuredTags),
        alsoKnownAs,
        ...(movedTo && { movedTo }),
        networkAcct: networkIdentity?.federatedUsername,
        remoteCreatedAt: apDate(actor.published),
        // Omitted, not written as `undefined`, when this refresh could not tell:
        // an absent key is what tells the store to keep the value it has.
        ...(followersCount !== undefined && { followersCount }),
        ...(followingCount !== undefined && { followingCount }),
        ...(postsCount !== undefined && { postsCount }),
        lastFetchedAt: new Date(),
      };

      const fedActor = await this.config.store.upsertActor(actorId, update, fetched.source);

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
            // The identity bridge takes a number or nothing; an unknown count is
            // sent as nothing rather than as a zero it would store.
            followersCount: followersCount ?? undefined,
            followingCount: followingCount ?? undefined,
            postsCount: postsCount ?? undefined,
            oxyUserId: fedActor.oxyUserId ?? undefined,
          };
          const oxyId = await this.config.identity.resolveExternalUser(normalized, {
            forceAvatarRefresh,
          });
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
  private resolveNetworkIdentity(candidate: NetworkIdentityCandidate): NetworkIdentity | undefined {
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
      domain.length === 0 ||
      localPart.length === 0 ||
      federatedUsername !== `${localPart}@${domain}`
    ) {
      this.config.logger.warn(
        `[FedSync] refusing network identity for ${candidate.actorUri}: ` +
          `"${derived.federatedUsername}" is not bindable to domain "${derived.instanceDomain}"`,
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
        this.config.logger.info(
          `[FedSync] 410 Gone for ${actorUri} — no stored actor row to tombstone`,
        );
        return;
      }

      this.config.logger.info(`[FedSync] tombstoned gone actor ${actorUri} (suspended)`);

      if (actor.oxyUserId) {
        const outcome = await this.config.identity.reportActorGone(actor.oxyUserId);
        this.config.logger.info(
          `[FedSync] actor-gone report for ${actorUri} (oxyUserId ${actor.oxyUserId}) → ${outcome}`,
        );
      }
    } catch (err) {
      this.config.logger.warn(`[FedSync] failed to tombstone gone actor ${actorUri}:`, err);
    }
  }

  /**
   * Read an ActivityPub collection's `totalItems`.
   *
   * Every failure used to come back as `0`, so a follower count the remote HID,
   * or one a timeout kept us from reading, was stored and shown as a real
   * "0 followers" — indistinguishable from an account nobody follows. A failure
   * now says which kind it is (see {@link CollectionCount}):
   *
   * - `null` when the answer is definitive: no collection advertised, 401/403
   *   (the owner hid it), 404/410 (it is gone), or a readable collection with no
   *   usable `totalItems` (the server does not publish the count).
   * - `undefined` when this attempt simply failed — a thrown fetch (timeout,
   *   network, SSRF refusal), any other non-2xx (429, 5xx), or a body that could
   *   not be read as a JSON object. The next refresh may well succeed, so the
   *   caller keeps whatever it last knew rather than forgetting it.
   */
  private async fetchCollectionCount(url?: string): Promise<CollectionCount> {
    if (!url) return null;
    try {
      const res = await this.config.signedFetch(url, AP_CONTENT_TYPE);
      if (!res.ok) {
        return COLLECTION_WITHHELD_STATUSES.has(res.status) ? null : undefined;
      }
      const col = await readBoundedResponseJson(res, { maxBytes: COLLECTION_BODY_MAX_BYTES });
      const total = col.totalItems;
      return typeof total === 'number' && Number.isSafeInteger(total) && total >= 0 ? total : null;
    } catch {
      return undefined;
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
      this.config.logger.info(
        `[FedSync] getOrFetchActor refusing own/blocked domain for ${actorUri}`,
      );
      return null;
    }
    const existing = await this.config.store.findActorByUri(actorUri);
    if (existing) {
      const isStale =
        !existing.lastFetchedAt || Date.now() - existing.lastFetchedAt.getTime() > ACTOR_STALE_MS;
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
    const refreshedRecently =
      typeof lastFetchedMs === 'number' &&
      Date.now() - lastFetchedMs < ACTOR_REFRESH_MIN_INTERVAL_MS;

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
        this.config.logger.warn(
          `[FedSync] background actor refresh failed for ${actorUri}: ${message}`,
        );
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
   *
   * With `refresh`, the key is fetched again from the actor that owns it — asked
   * when the stored key did not verify a signature, because an actor that rotated
   * its key keeps its keyId. The stored actor is updated with what comes back.
   */
  async fetchPublicKey(
    keyId: string,
    options: FetchPublicKeyOptions = {},
  ): Promise<{ publicKeyPem: string; actorUri: string } | null> {
    const stored = await this.config.store.findActorByPublicKeyId(keyId);
    // keyId is typically the actor URI with #main-key appended
    const actorUri = stored?.uri ?? keyId.replace(/#.*$/, '');

    if (options.refresh) {
      const actor = await this.refetchActorKey(actorUri);
      return actor?.publicKeyPem ? { publicKeyPem: actor.publicKeyPem, actorUri: actor.uri } : null;
    }

    if (stored?.publicKeyPem) {
      return { publicKeyPem: stored.publicKeyPem, actorUri: stored.uri };
    }

    // Fetch the actor to get the public key (uses 24h cache)
    const actor = await this.getOrFetchActor(actorUri);
    if (!actor?.publicKeyPem) return null;

    return { publicKeyPem: actor.publicKeyPem, actorUri: actor.uri };
  }

  /**
   * Fetch `actorUri` again for its current key, or null when it was fetched too
   * recently for that to tell anything new (see {@link KEY_REFETCH_MIN_INTERVAL_MS})
   * or cannot be fetched. `fetchRemoteActor` refuses a blocked host.
   */
  private refetchActorKey(actorUri: string): Promise<TActor | null> {
    let refetch = this.inFlightKeyRefetches.get(actorUri);
    if (!refetch) {
      refetch = (async () => {
        const existing = await this.config.store.findActorByUri(actorUri);
        const fetchedMs = existing?.lastFetchedAt?.getTime();
        if (typeof fetchedMs === 'number' && Date.now() - fetchedMs < KEY_REFETCH_MIN_INTERVAL_MS) {
          return null;
        }
        return this.fetchRemoteActor(actorUri, false, existing?.acct);
      })().finally(() => {
        this.inFlightKeyRefetches.delete(actorUri);
      });
      this.inFlightKeyRefetches.set(actorUri, refetch);
    }
    return refetch;
  }
}

/** Build the remote-actor resolver from an app's storage + identity + transports. */
export function createActorResolver<TActor extends FederatedActorRecordBase, TSource = undefined>(
  config: ActorResolverConfig<TActor, TSource>,
): ActorResolver<TActor, TSource> {
  return new ActorResolver(config);
}
