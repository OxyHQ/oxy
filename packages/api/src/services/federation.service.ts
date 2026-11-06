/**
 * Federation Service
 *
 * Resolves fediverse (ActivityPub) handles to Oxy user profiles.
 * Handles WebFinger discovery, actor profile fetching, avatar download, and user upsert.
 * Signs outgoing requests with HTTP Signatures for servers that enforce authorized fetch.
 *
 * The methods that call one another (and that tests spy on) live on
 * {@link FederationService}; the module-level pieces live under `./federation/`:
 * `transport` (SSRF-safe and signed fetches), `localActor` (Oxy's own actor
 * documents), `avatarDownload` (picture mirroring), `externalIdentity` and
 * `atproto` (resolve shapes and Bluesky sources), `handles`, `ownDomain` and
 * `refreshThrottle`. Everything this module exported before is re-exported here.
 */

import { replaceSourceProfileLinks } from './profileLinks.service';
import { eq } from 'drizzle-orm';
import {
  blueskyHandleFromUsername,
  BSKY_NETWORK_DOMAIN,
  canonicalFederationHost,
  federatedUsernameFromUpstreamUrl,
  isActivityPubMediaType,
} from '@oxy.so/federation';
import { getDb } from '../config/postgres';
import { users } from '../db/schema/users';
import { externalIdentityActors } from '../db/schema/externalIdentities';
import { FEDERATION_BRIDGE_POLICY } from '../config/federationBridgePolicy';
import { userService, type AccountDocument } from './user.service';
import { logger } from '../utils/logger';
import userCache from '../utils/userCache';
import { isAvatarFileId, persistFederatedAvatar } from '../utils/federatedAvatar';
import { cleanAccountName } from '../utils/displayNameSanitize';
import { composeInstanceKeyId, findKeyPair } from './federation/actorKeys';
import { resolutionFailure, type ActorProfileResult } from './federation/resolutionFailure';
import {
  deriveExternalActorProfile,
  externalProfileKind,
  type ExternalActorProfile,
} from './federation/externalIdentityPolicy';
import { fetchMetaFirstPartyProfilePair } from './federation/metaFirstPartyProof.service';
import { unresolvableHandles } from './federation/unresolvableHandles';
import {
  fetchInstagramGraphProfile,
  INSTAGRAM_GRAPH_PROTOCOL,
  INSTAGRAM_NETWORK_DOMAIN,
  instagramGraphUserIdFromActorUri,
  instagramUsernameFromAcct,
  isInstagramGraphActorUri,
  isInstagramGraphConfigured,
} from './federation/instagramGraph';
import {
  recordInstagramSourcePin,
  recordMetaIdentityProof,
  revokeMetaIdentityProof,
  type MetaIdentityProofOutcome,
} from './federation/metaIdentityProofRegistry.service';
import {
  getExternalIdentitiesForUser,
  lookupExternalIdentity,
  registerExternalIdentity,
  resolveCanonicalUserId,
} from './externalIdentityRegistry.service';
import { AP_DOMAIN, isOwnFederationDomain } from './federation/ownDomain';
import {
  AP_ACCEPT_TYPES,
  discardBody,
  expandTcoLinks,
  FEDERATION_FETCH_TIMEOUT_MS,
  readFederationJson,
  readSignedFetchJson,
  safeFederationFetch,
  signedFetch,
} from './federation/transport';
import {
  ATPROTO_DID_RE,
  blueskyAcctFromHandle,
  domainFromHandle,
  lacksRoutedTransport,
  missIsInconclusive,
  normalizeFediverseHandle,
  TRANSIENT_NOT_FOUND_HOSTS,
  TRANSIENT_NOT_FOUND_RETRY_DELAYS_MS,
  transportHandleForExternalAccount,
} from './federation/handles';
import { claimRefreshSlot, releaseRefreshSlot, STALE_MS } from './federation/refreshThrottle';
import {
  AVATAR_REFRESH_MIN_INTERVAL_MS,
  type AvatarDownloadResult,
  claimAvatarRefreshSlot,
  FEDERATION_SYSTEM_USER,
  fetchAndStoreAvatar,
  freshInstagramGraphAvatarUrl,
  releaseAvatarRefreshSlot,
  storedAvatarExists,
  storedAvatarFileId,
} from './federation/avatarDownload';
import type { AccountKind } from './federation/localActor';
import {
  federatedProfile,
  identityResponse,
  type SourceFailure,
  type SourceObservation,
  type StoredExternalSource,
  type WebFingerResolution,
} from './federation/externalIdentity';
import { fetchAtprotoSource, resolveAtprotoHandle } from './federation/atproto';

export { isOwnFederationDomain, OWN_FEDERATION_DOMAINS } from './federation/ownDomain';
export { isFediverseHandle } from './federation/handles';
// Key custody, and the rule that a user key belongs to one account lifetime,
// live in `./federation/actorKeys`. Re-exported here for the routes.
export {
  getPublicKeyForKeyId,
  getUserKeyPair,
  getUserPublicKey,
  signWithKeyId,
} from './federation/actorKeys';
export { ensureInstanceKeyId } from './federation/transport';
export type { SourceFailure } from './federation/externalIdentity';
export { getInstanceActor, getUserActor, type ActorSourceUser } from './federation/localActor';
export {
  isExpiredSignedAvatarUrl,
  storedAvatarFileId,
  type AvatarDownloadResult,
  type AvatarFailureReason,
  type AvatarMirrorFailure,
} from './federation/avatarDownload';

class FederationService {
  /**
   * Resolve a WebFinger acct to an ActivityPub actor URI.
   * @param acct - e.g. "alice@mastodon.social" or "@alice@mastodon.social"
   */
  async resolveWebFingerResource(acct: string): Promise<WebFingerResolution | null> {
    const normalizedAcct = normalizeFediverseHandle(acct);
    if (!normalizedAcct) {
      resolutionFailure('webfinger_fetch', 'invalid_selector', {});
      return null;
    }

    const domain = domainFromHandle(normalizedAcct);
    if (!domain) {
      resolutionFailure('webfinger_fetch', 'invalid_selector', {});
      return null;
    }

    const resource = `acct:${normalizedAcct}`;
    const url = `https://${domain}/.well-known/webfinger?resource=${encodeURIComponent(resource)}`;

    try {
      const res = await safeFederationFetch(url, {
        headers: { Accept: 'application/jrd+json, application/json' },
        timeoutMs: FEDERATION_FETCH_TIMEOUT_MS,
      });
      if (!res || res.status < 200 || res.status >= 300) {
        resolutionFailure(
          'webfinger_fetch',
          res ? 'http_status' : 'transport_unavailable',
          { acct: normalizedAcct },
          res?.status,
        );
        res?.response.destroy();
        return null;
      }

      const data = await readFederationJson<{
        subject?: string;
        links?: Array<{ rel?: string; type?: string; href?: string }>;
      }>(res.response);
      if (!data) {
        resolutionFailure(
          'webfinger_document',
          'unreadable_document',
          { acct: normalizedAcct },
          res.status,
        );
        return null;
      }

      const link = data.links?.find((l) => l.rel === 'self' && isActivityPubMediaType(l.type));
      if (!link?.href) {
        resolutionFailure(
          'webfinger_document',
          'missing_self_link',
          { acct: normalizedAcct },
          res.status,
        );
        return null;
      }

      const subjectAcct =
        typeof data.subject === 'string'
          ? normalizeFediverseHandle(data.subject) || undefined
          : undefined;

      return {
        actorUri: link.href,
        subjectAcct,
      };
    } catch {
      resolutionFailure('webfinger_document', 'unexpected_failure', { acct: normalizedAcct });
      return null;
    }
  }

  /**
   * Resolve a WebFinger acct to an ActivityPub actor URI.
   * @param acct - e.g. "alice@mastodon.social" or "@alice@mastodon.social"
   */
  async resolveWebFinger(acct: string): Promise<string | null> {
    const resolution = await this.resolveWebFingerResource(acct);
    return resolution?.actorUri || null;
  }

  /**
   * Returns the acct that can be safely used as the canonical username for a
   * WebFinger result. A remote WebFinger endpoint may advertise `subject` as a
   * canonical alias (for example `user@www.example` -> `user@example`), but that
   * claimed account is controlled by a different domain. Before storing it,
   * resolve the claimed account through its own domain and require it to point
   * back to the same actor URI — otherwise an attacker domain could spoof an
   * identity on a trusted domain.
   */
  private async verifiedAccountForResolution(
    requestedAcct: string,
    resolution: WebFingerResolution,
  ): Promise<string> {
    const requested = normalizeFediverseHandle(requestedAcct);
    const subject = resolution.subjectAcct
      ? normalizeFediverseHandle(resolution.subjectAcct)
      : null;
    if (!requested || !subject || subject === requested) {
      return requested || requestedAcct.toLowerCase();
    }

    try {
      const subjectResolution = await this.resolveWebFingerResource(subject);
      if (subjectResolution?.actorUri === resolution.actorUri) {
        return subject;
      }

      logger.warn(
        `Ignoring unverified WebFinger subject ${subject} for ${requested}: ` +
          `expected actor ${resolution.actorUri}, got ${subjectResolution?.actorUri || 'none'}`,
      );
    } catch (err) {
      logger.warn(
        `Failed verifying WebFinger subject ${subject} for ${requested}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return requested;
  }

  /**
   * Fetch an ActivityPub actor by URI and extract user-profile fields.
   * Uses HTTP Signature for servers that enforce authorized fetch.
   */
  async fetchActorProfile(
    actorUri: string,
    acctHint?: string,
  ): Promise<ExternalActorProfile | null> {
    const result = await this.fetchActorProfileResult(actorUri, acctHint);
    return result.ok ? result.profile : null;
  }

  /**
   * Fetch an actor document FRESH — never from a cache — through the signed,
   * DNS-pinned client, and return it raw. `null` unless the fetch succeeded and
   * the document's `id` is exactly the requested URI — a redirect to another
   * actor does not speak for this one. Used where a decision rests on what the
   * actor says NOW, such as a Move's `movedTo`.
   */
  async fetchActorDocument(actorUri: string): Promise<Record<string, unknown> | null> {
    try {
      const res = await signedFetch(actorUri, AP_ACCEPT_TYPES[0]);
      if (!res || res.response.status < 200 || res.response.status >= 300) {
        if (res) discardBody(res.response);
        return null;
      }
      const actor = await readSignedFetchJson(res.response);
      return actor?.id === actorUri ? actor : null;
    } catch {
      return null;
    }
  }

  /** Internal diagnostics preserve the public nullable profile contract. */
  async fetchActorProfileResult(
    actorUri: string,
    acctHint?: string,
    options: { readonlySigningKey?: boolean } = {},
  ): Promise<ActorProfileResult<ExternalActorProfile>> {
    try {
      // Read-only callers never mint the instance key: without one, nothing is fetched.
      if (options.readonlySigningKey && !(await findKeyPair(composeInstanceKeyId(AP_DOMAIN))))
        return resolutionFailure('actor_fetch', 'signing_key_unavailable', { actorUri });
      const fetchOptions = { readonlySigningKey: options.readonlySigningKey };
      let res = await signedFetch(actorUri, AP_ACCEPT_TYPES[0], fetchOptions);
      if (
        res?.response.status === 404 &&
        TRANSIENT_NOT_FOUND_HOSTS.has(new URL(actorUri).hostname)
      ) {
        for (const delayMs of TRANSIENT_NOT_FOUND_RETRY_DELAYS_MS) {
          discardBody(res.response);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          res = await signedFetch(actorUri, AP_ACCEPT_TYPES[0], fetchOptions);
          if (res?.response.status !== 404) break;
        }
      }
      if (!res || res.response.status < 200 || res.response.status >= 300) {
        if (res) discardBody(res.response);
        return resolutionFailure(
          'actor_fetch',
          res ? 'http_status' : 'transport_unavailable',
          { actorUri },
          res?.response.status,
        );
      }
      const { response, finalUrl } = res;
      const actor = await readSignedFetchJson(response);
      if (!actor)
        return resolutionFailure(
          'actor_document',
          'unreadable_document',
          { actorUri },
          response.status,
        );
      if (typeof actor.id !== 'string' || !actor.inbox)
        return resolutionFailure(
          'actor_document',
          'missing_actor_fields',
          { actorUri },
          response.status,
        );
      // The fetch's final URL, rather than a caller assertion, binds the actor.
      if (actor.id !== actorUri && actor.id !== finalUrl)
        return resolutionFailure(
          'actor_document',
          'actor_id_mismatch',
          { actorUri },
          response.status,
        );
      const profile = deriveExternalActorProfile(actor, actor.id, acctHint);
      if (!profile)
        return resolutionFailure(
          'identity_policy',
          'identity_policy_rejected',
          { actorUri },
          response.status,
        );
      profile.bio = await expandTcoLinks(profile.bio);
      const actorHost = canonicalFederationHost(new URL(actor.id).hostname);
      // Split account/actor hosts are legitimate only when the account host's
      // WebFinger names this exact actor. Neither caller hints nor actor fields
      // may claim an unrelated remote account without that reverse binding.
      // Only the account is relabelled: the transport stays the actor-host
      // handle, as it does for every bridge, so an identity first registered
      // under that handle is promoted to the verified one by the registry's
      // transport rule instead of refused on every later resolve.
      const candidate =
        typeof actor.webfinger === 'string'
          ? normalizeFediverseHandle(actor.webfinger)
          : acctHint
            ? normalizeFediverseHandle(acctHint)
            : null;
      const candidateHost = candidate ? domainFromHandle(candidate) : null;
      if (
        candidate &&
        candidateHost &&
        candidateHost !== actorHost &&
        profile.domain === actorHost
      ) {
        const binding = await this.resolveWebFingerResource(candidate);
        if (binding?.actorUri === actor.id) {
          profile.username = candidate.toLowerCase();
          profile.domain = candidateHost;
        }
      }
      return { ok: true, profile, document: actor };
    } catch {
      return resolutionFailure('actor_fetch', 'unexpected_failure', { actorUri });
    }
  }

  /** The verified profile of a Bluesky account by its DID, or null. */
  async fetchAtprotoProfile(did: string): Promise<ExternalActorProfile | null> {
    return (await fetchAtprotoSource(did))?.profile ?? null;
  }

  normalizeExternalHandle(value: string): string | null {
    const upstream = federatedUsernameFromUpstreamUrl(value);
    if (upstream) return upstream;
    try {
      const url = new URL(value);
      if (
        ['threads.net', 'threads.com', 'www.threads.net', 'www.threads.com'].includes(url.hostname)
      ) {
        const match = url.pathname.match(/^\/@?([a-z0-9._]+)\/?$/i);
        if (match) return `${match[1].toLowerCase()}@threads.net`;
      }
    } catch {
      /* A handle is not a URL. */
    }
    // A bare DNS name is an atproto handle: no `@`, so never a fediverse acct.
    return blueskyAcctFromHandle(value) ?? normalizeFediverseHandle(value);
  }

  async needsBridgeCanonicalization(actorUri: string): Promise<boolean> {
    let host: string;
    try {
      host = canonicalFederationHost(new URL(actorUri).hostname);
    } catch {
      return false;
    }
    if (
      !FEDERATION_BRIDGE_POLICY.some((entry) => entry.host === host && entry.relabel === 'enabled')
    )
      return false;
    const [actor] = await getDb()
      .select({ verifiedAt: externalIdentityActors.updatedAt })
      .from(externalIdentityActors)
      .where(eq(externalIdentityActors.actorUri, actorUri))
      .limit(1);
    return !actor || actor.verifiedAt.getTime() === 0;
  }

  /** First-party badges are an additional proof; they never rewrite legacy ownership. */
  private async refreshMetaIdentityProof(
    source: ExternalActorProfile,
    registered: Awaited<ReturnType<typeof registerExternalIdentity>>,
  ): Promise<MetaIdentityProofOutcome | undefined> {
    if (!['instagram.com', 'threads.net'].includes(source.domain)) return undefined;
    const startedAt = new Date();
    let sourceOwnerVerified = !registered.deferredInstagramOwnerRefresh;
    const refuse = async (reason: string): Promise<MetaIdentityProofOutcome> => {
      await revokeMetaIdentityProof(
        source.username,
        reason,
        startedAt,
        ['source_binding_changed', 'source_profile_contradiction'].includes(reason),
      );
      return { state: 'refused', reason, sourceOwnerVerified };
    };
    const persistVerifiedOwner = (
      profile: ExternalActorProfile,
      own: NonNullable<
        Awaited<ReturnType<typeof fetchMetaFirstPartyProfilePair>>['instagramProfile']
      >,
    ) =>
      registerExternalIdentity({
        canonicalAcct: profile.username,
        actorUri: profile.actorUri,
        transportAcct: profile.transportAcct,
        protocol: profile.protocol,
        stableId: profile.stableId,
        evidenceLinks: profile.evidenceLinks,
        profile: federatedProfile(profile),
        verifiedInstagramPin: { documentHash: own.documentHash, verifiedAt: own.fetchedAt },
      });
    const evidence = await fetchMetaFirstPartyProfilePair({ sourceAcct: source.username });
    // Both sides of every comparison are cleaned by the policy of the SOURCE
    // profile's kind, so a title is never compared against a person's cleaning.
    const normalizeName = (value: string, kind: AccountKind | undefined) =>
      cleanAccountName(value, kind).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
    if (source.domain === 'instagram.com' && evidence.instagramProfile) {
      const own = evidence.instagramProfile;
      if (
        own.canonicalAcct !== source.username ||
        (normalizeName(source.displayName, externalProfileKind(source)) &&
          normalizeName(own.displayName, externalProfileKind(source)) &&
          normalizeName(source.displayName, externalProfileKind(source)) !==
            normalizeName(own.displayName, externalProfileKind(source)))
      )
        return refuse('source_profile_contradiction');
      const pin = await recordInstagramSourcePin(source.actorUri, own, {
        createdInstagramUserId: registered.createdUser ? registered.identity.userId : undefined,
      });
      if (pin.state === 'refused') return refuse(pin.reason ?? 'source_binding_changed');
      if (pin.state === 'verified') {
        sourceOwnerVerified = !(await persistVerifiedOwner(source, own))
          .deferredInstagramOwnerRefresh;
        if (!sourceOwnerVerified) return refuse('proof_predates_revocation');
      }
    }
    if (evidence.status !== 'verified') return refuse(evidence.reason);
    const { pair } = evidence;
    const binding = await this.resolveWebFingerResource(pair.threads.canonicalAcct);
    if (!binding || binding.subjectAcct !== pair.threads.canonicalAcct)
      return refuse('threads_webfinger_binding_missing');
    const threads =
      source.domain === 'threads.net'
        ? source
        : await this.fetchActorProfile(binding.actorUri, pair.threads.canonicalAcct);
    // AP and public-web numeric IDs inhabit different namespaces. The official
    // WebFinger subject and signed actor bind them; numeric equality is irrelevant.
    if (
      !threads ||
      threads.actorUri !== binding.actorUri ||
      threads.username !== pair.threads.canonicalAcct ||
      threads.stableId !== threads.actorUri ||
      threads.domain !== 'threads.net'
    )
      return refuse('threads_actor_binding_missing');
    let instagram = source.domain === 'instagram.com' ? source : null;
    if (!instagram) {
      const transport = transportHandleForExternalAccount(pair.instagram.canonicalAcct);
      const discovered = await this.resolveWebFingerResource(transport);
      if (discovered?.subjectAcct) {
        const verified = await this.verifiedAccountForResolution(transport, discovered);
        if (verified === discovered.subjectAcct)
          instagram = await this.fetchActorProfile(discovered.actorUri, verified);
      }
    }
    if (
      !instagram ||
      instagram.username !== pair.instagram.canonicalAcct ||
      instagram.domain !== 'instagram.com'
    ) {
      return refuse('instagram_actor_binding_missing');
    }
    for (const [profile, document] of [
      [instagram, pair.instagram],
      [threads, pair.threads],
    ] as const) {
      const sourceName = normalizeName(profile.displayName, externalProfileKind(profile));
      const firstPartyName = normalizeName(document.displayName, externalProfileKind(profile));
      if (sourceName && firstPartyName && sourceName !== firstPartyName)
        return refuse('source_profile_contradiction');
    }
    const persist = (profile: ExternalActorProfile) =>
      registerExternalIdentity({
        canonicalAcct: profile.username,
        actorUri: profile.actorUri,
        transportAcct: profile.transportAcct,
        protocol: profile.protocol,
        stableId: profile.stableId,
        evidenceLinks: profile.evidenceLinks,
        profile: federatedProfile(profile),
      });
    const instagramRegistration =
      source.domain === 'instagram.com' ? registered : await persist(instagram);
    if (source.domain !== 'instagram.com' && evidence.instagramProfile) {
      const pin = await recordInstagramSourcePin(instagram.actorUri, evidence.instagramProfile, {
        createdInstagramUserId: instagramRegistration.createdUser
          ? instagramRegistration.identity.userId
          : undefined,
      });
      if (pin.state === 'refused') return refuse(pin.reason ?? 'source_binding_changed');
      if (
        pin.state === 'verified' &&
        (await persistVerifiedOwner(instagram, evidence.instagramProfile))
          .deferredInstagramOwnerRefresh
      )
        return refuse('proof_predates_revocation');
    }
    if (source.domain !== 'threads.net') await persist(threads);
    const outcome = await recordMetaIdentityProof(
      {
        instagramActorUri: instagram.actorUri,
        threadsActorUri: threads.actorUri,
        instagramAcct: pair.instagram.canonicalAcct,
        threadsAcct: pair.threads.canonicalAcct,
        instagramPk: pair.instagram.pk,
        instagramGraphId: pair.instagram.graphId,
        threadsWebPk: pair.threads.webPk,
        instagramProfileUrl: pair.instagram.profileUrl,
        threadsProfileUrl: pair.threads.profileUrl,
        policyVersion: pair.policyVersion,
        instagramDocumentHash: pair.instagram.documentHash,
        threadsDocumentHash: pair.threads.documentHash,
        evidenceDigest: pair.evidenceHash,
        verifiedAt: new Date(pair.fetchedAt),
      },
      {
        createdInstagramUserId: instagramRegistration.createdUser
          ? instagramRegistration.identity.userId
          : undefined,
      },
    );
    return { ...outcome, sourceOwnerVerified };
  }

  async resolveExternalIdentity(
    input: {
      actorUri?: string;
      handle?: string;
      transportAcct?: string;
      protocol?: string;
    },
    failure?: SourceFailure,
  ) {
    if (input.actorUri)
      return this.resolveExternalActorIdentity(input.actorUri, input.transportAcct, { failure });
    // A DID is already an atproto actor id.
    const did = input.handle?.trim();
    if (did && ATPROTO_DID_RE.test(did))
      return this.resolveExternalActorIdentity(did, undefined, { failure });
    const handle = input.handle ? this.normalizeExternalHandle(input.handle) : null;
    if (!handle) return null;
    const at = handle.lastIndexOf('@');
    const domain = handle.slice(at + 1);
    const instagram = domain === INSTAGRAM_NETWORK_DOMAIN;
    // An explicit Graph request goes straight to Business Discovery.
    if (input.protocol === INSTAGRAM_GRAPH_PROTOCOL)
      return instagram ? this.resolveInstagramGraphHandle(handle) : null;
    // Any failed bridge resolution of an Instagram account (429, timeout,
    // refusal) may fall back to Graph; without Graph credentials it stays null.
    const graphFallback = () =>
      instagram ? this.resolveInstagramGraphHandle(handle) : Promise.resolve(null);
    const userId = await lookupExternalIdentity(handle);
    if (userId) {
      const identities = (await getExternalIdentitiesForUser(userId)).filter(
        (identity) => identity.canonicalAcct === handle || identity.transportAcct === handle,
      );
      // The bridge actor carries the Meta proof path, so it is preferred; a
      // Graph-only source falls through to fresh bridge discovery below.
      const source =
        identities.find((identity) => identity.protocol !== INSTAGRAM_GRAPH_PROTOCOL) ??
        (instagram ? undefined : identities[0]);
      if (source)
        return (
          (instagram
            ? await this.resolveExternalActorIdentity(source.actorUri, source.transportAcct)
            : await this.storedExternalIdentity(userId, source)) ?? graphFallback()
        );
    }
    if (isOwnFederationDomain(domain)) return null;
    return (await this.discoverThroughRoutedTransport(handle)) ?? graphFallback();
  }

  /**
   * First discovery of `handle` (a normalized `local@network` account) through
   * the transport Oxy routes its network through
   * ({@link transportHandleForExternalAccount}), or null when that transport does
   * not answer for exactly this account.
   */
  private async discoverThroughRoutedTransport(handle: string) {
    const at = handle.lastIndexOf('@');
    // Bluesky speaks no WebFinger: its handle resolves to a DID, and the profile
    // fetched by that DID must name this same account back.
    if (handle.slice(at + 1) === BSKY_NETWORK_DOMAIN) {
      // An account whose handle does not verify is already named by its DID.
      const local = handle.slice(0, at);
      const atprotoDid = ATPROTO_DID_RE.test(local)
        ? local
        : await resolveAtprotoHandle(blueskyHandleFromUsername(local));
      if (!atprotoDid) return null;
      const result = await this.resolveExternalActorIdentity(atprotoDid);
      return result?.externalIdentity.canonicalAcct === handle ? result : null;
    }
    // Reverse transport routing is also Oxy policy. The fetched actor must still
    // publish the reviewed per-account assertion before the identity is accepted.
    const transport = transportHandleForExternalAccount(handle);
    const webfinger = await this.resolveWebFingerResource(transport);
    if (!webfinger) return null;
    const verifiedAcct = await this.verifiedAccountForResolution(transport, webfinger);
    const result = await this.resolveExternalActorIdentity(webfinger.actorUri, verifiedAcct);
    if (!result || (transport !== handle && result.externalIdentity.canonicalAcct !== handle))
      return null;
    return result;
  }

  /**
   * Register the routed transport of an account first registered through
   * another one, in the background: an X account seen only through mastox.eu
   * gets its bird.makeup actor, a Bluesky account seen only through Bridgy Fed
   * its native DID. An app that reads every transport of an identity
   * (`externalIdentities`) can then reach the one whose posts carry the
   * network's own post id. Once per account per refresh interval, under the
   * same storm guard as the other background work; NEVER awaits and NEVER
   * throws. A discovery that fails is simply tried again on a later
   * registration.
   */
  private scheduleRoutedTransportDiscovery(profile: ExternalActorProfile): void {
    if (profile.protocol === INSTAGRAM_GRAPH_PROTOCOL) return;
    if (!lacksRoutedTransport(profile.username, [profile])) return;
    const key = `routed-transport:${profile.username}`;
    if (!claimRefreshSlot(key)) return;
    void (async () => {
      const actors = await getDb()
        .select({
          transportAcct: externalIdentityActors.transportAcct,
          protocol: externalIdentityActors.protocol,
        })
        .from(externalIdentityActors)
        .where(eq(externalIdentityActors.canonicalAcct, profile.username));
      if (lacksRoutedTransport(profile.username, actors))
        await this.discoverThroughRoutedTransport(profile.username);
    })()
      .catch((err) => {
        logger.warn(
          `Routed transport discovery failed for ${profile.username}: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        releaseRefreshSlot(key);
      });
  }

  /** Business Discovery for one `<username>@instagram.com`; null when disabled or not discoverable. */
  private async resolveInstagramGraphHandle(handle: string) {
    if (!isInstagramGraphConfigured()) return null;
    const lookup = await fetchInstagramGraphProfile(handle);
    if (!lookup.ok) return null;
    // An IG User id survives a username change. A Graph source already bound to
    // another handle is not silently re-pointed: that is a rename (or reuse) the
    // registry has no ownership proof for.
    const [bound] = await getDb()
      .select({ canonicalAcct: externalIdentityActors.canonicalAcct })
      .from(externalIdentityActors)
      .where(eq(externalIdentityActors.actorUri, lookup.profile.actorUri))
      .limit(1);
    if (bound && bound.canonicalAcct !== lookup.profile.username) {
      logger.warn('Instagram Graph source refused', {
        operation: 'instagram_graph_resolve',
        reason: 'graph_id_bound_to_other_account',
        username: lookup.profile.username,
      });
      return null;
    }
    return this.persistResolvedProfile(lookup.profile, {});
  }

  /**
   * Refresh a stored Graph source: re-query Business Discovery by the username it
   * was registered under and refuse when that username now names another IG User
   * (a recycled handle). Graph outages never revoke bridge-backed Meta proofs.
   */
  private async resolveInstagramGraphActorIdentity(
    actorUri: string,
    transportAcct: string | undefined,
    opts: { forceAvatarRefresh?: boolean },
  ) {
    const igUserId = instagramGraphUserIdFromActorUri(actorUri);
    if (!igUserId || !isInstagramGraphConfigured()) return null;
    const [stored] = await getDb()
      .select({ transportAcct: externalIdentityActors.transportAcct })
      .from(externalIdentityActors)
      .where(eq(externalIdentityActors.actorUri, actorUri))
      .limit(1);
    const username = instagramUsernameFromAcct(stored?.transportAcct ?? transportAcct ?? '');
    if (!username) return null;
    const lookup = await fetchInstagramGraphProfile(username);
    if (!lookup.ok) return null;
    if (lookup.profile.actorUri !== actorUri) {
      logger.warn('Instagram Graph source refused', {
        operation: 'instagram_graph_refresh',
        reason: 'username_names_another_account',
        username,
      });
      return null;
    }
    return this.persistResolvedProfile(lookup.profile, opts);
  }

  /**
   * The single persistence path used by public discovery and every connector.
   * It always fetches the source, and its answer carries the document fetched
   * (`sourceDocument`), so a caller never fetches the same source again. When
   * the source answers an HTTP error, `opts.failure.sourceStatus` says which.
   */
  async resolveExternalActorIdentity(
    actorUri: string,
    transportAcct?: string,
    opts: { forceAvatarRefresh?: boolean; failure?: SourceFailure } = {},
  ) {
    // Not a URL: dispatched before any URL parsing, and never through the
    // proof-revoking unavailable path below.
    if (isInstagramGraphActorUri(actorUri))
      return this.resolveInstagramGraphActorIdentity(actorUri, transportAcct, opts);
    if (!actorUri.startsWith('did:')) {
      try {
        if (isOwnFederationDomain(new URL(actorUri).hostname)) return null;
      } catch {
        return null;
      }
    }
    const startedAt = new Date();
    const observed = actorUri.startsWith('did:')
      ? await fetchAtprotoSource(actorUri)
      : await this.fetchActorSource(actorUri, transportAcct, opts.failure);
    if (!observed) {
      await revokeMetaIdentityProof(actorUri, 'source_actor_unavailable', startedAt);
      return null;
    }
    return this.persistResolvedProfile(observed.profile, opts, observed.document);
  }

  /** {@link fetchActorProfileResult} as an observation, reporting an HTTP refusal into `failure`. */
  private async fetchActorSource(
    actorUri: string,
    transportAcct: string | undefined,
    failure: SourceFailure | undefined,
  ): Promise<SourceObservation | null> {
    const result = await this.fetchActorProfileResult(actorUri, transportAcct);
    if (result.ok) return { profile: result.profile, document: result.document };
    if (failure && result.failure.reason === 'http_status')
      failure.sourceStatus = result.failure.httpStatus;
    return null;
  }

  /**
   * Register a profile already fetched with {@link fetchActorProfileResult}: the
   * persistence half of {@link resolveExternalActorIdentity}, with the same
   * checks and writes, for a caller that puts its own deadline on the fetch.
   */
  async registerFetchedActorProfile(profile: ExternalActorProfile) {
    return this.persistResolvedProfile(profile, {});
  }

  /** Register a freshly fetched source profile and project the canonical person. */
  private async persistResolvedProfile(
    profile: ExternalActorProfile,
    opts: { forceAvatarRefresh?: boolean },
    sourceDocument?: Record<string, unknown>,
  ) {
    if (isOwnFederationDomain(profile.domain)) return null;
    const result = await registerExternalIdentity({
      canonicalAcct: profile.username,
      actorUri: profile.actorUri,
      transportAcct: profile.transportAcct,
      protocol: profile.protocol,
      stableId: profile.stableId,
      evidenceLinks: profile.evidenceLinks,
      profile: federatedProfile(profile),
    });
    this.scheduleRoutedTransportDiscovery(profile);
    // First-party badge proofs bind bridge actors; a Graph source is admitted by
    // the registry's pinned graph-id check and never records or revokes them.
    const identityCheck =
      profile.protocol === INSTAGRAM_GRAPH_PROTOCOL
        ? undefined
        : await this.refreshMetaIdentityProof(profile, result);
    const sourceOwnerVerified = identityCheck?.sourceOwnerVerified;
    const identityProof = identityCheck
      ? {
          state: identityCheck.state,
          ...(identityCheck.reason ? { reason: identityCheck.reason } : {}),
        }
      : undefined;
    const canonicalUserId = await resolveCanonicalUserId(result.identity.userId);
    // The source's links are the account's profile links, held as a native
    // account's are. Identity resolution does not wait on them: a Clarity outage
    // or a failed write keeps the links the account already had.
    await replaceSourceProfileLinks(canonicalUserId, profile.links).catch((error: unknown) =>
      logger.warn('Source profile links not synced; keeping the account’s links', {
        actorUri: profile.actorUri,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    userCache.invalidate(canonicalUserId);
    userCache.invalidate(result.userId);
    userCache.invalidate(result.identity.userId);
    if (result.deferredInstagramOwnerRefresh && !sourceOwnerVerified) return null;
    if (
      profile.domain === 'instagram.com' &&
      [
        'source_binding_changed',
        'source_profile_contradiction',
        'proof_predates_revocation',
      ].includes(identityProof?.reason ?? '')
    )
      return null;
    const user = await userService.readAccountDocument(canonicalUserId);
    if (!user) return null;
    if (profile.avatarUrl) {
      const [source] = await getDb()
        .select({ avatar: users.avatar })
        .from(users)
        .where(eq(users.id, result.identity.userId));
      const avatar = source?.avatar ?? undefined;
      if (opts.forceAvatarRefresh || !isAvatarFileId(avatar)) {
        this.scheduleAvatarRefresh(
          result.identity.userId,
          profile.avatarUrl,
          storedAvatarFileId(avatar),
          { force: opts.forceAvatarRefresh === true },
        );
      }
    }
    return identityResponse(
      user,
      canonicalUserId,
      {
        canonicalAcct: profile.username,
        network: profile.domain,
        protocol: profile.protocol,
        actorUri: profile.actorUri,
        transportAcct: profile.transportAcct,
      },
      result.userId,
      identityProof,
      sourceDocument,
    );
  }

  /**
   * A handle the registry already holds, answered from what was verified when it
   * was stored: no remote fetch on the request path. A resolve used to re-fetch
   * the source on every call, so a known account vanished whenever its source
   * answered badly — bird.makeup answers 404 for a freshly mirrored account on
   * most requests (measured 2026-11-04: elctrixr 3 of 10, while long-mirrored
   * accounts answer 10 of 10) — and every search-as-you-type probe waited on it.
   *
   * A stored row is kept current the way a profile read keeps it current: once
   * its verification is older than {@link STALE_MS} the source is re-verified in
   * the background. A source that has never been verified (a backfilled bridge
   * row, epoch `updated_at`) has not had first discovery yet, so it is verified
   * here, inline, exactly as an unknown handle would be. An archived (gone)
   * account resolves to nothing, as a fetch of it would.
   */
  private async storedExternalIdentity(
    userId: string,
    source: StoredExternalSource & { sourceUserId: string },
  ) {
    const [actor] = await getDb()
      .select({ verifiedAt: externalIdentityActors.updatedAt })
      .from(externalIdentityActors)
      .where(eq(externalIdentityActors.actorUri, source.actorUri))
      .limit(1);
    const verifiedAt = actor?.verifiedAt.getTime() ?? 0;
    if (verifiedAt === 0)
      return this.resolveExternalActorIdentity(source.actorUri, source.transportAcct);
    if (Date.now() - verifiedAt >= STALE_MS)
      this.scheduleSourceVerification(source.actorUri, source.transportAcct);
    const user = await userService.readAccountDocument(userId);
    if (!user || user.accountStatus === 'archived') return null;
    return identityResponse(user, userId, source, source.sourceUserId);
  }

  /**
   * Download a remote avatar image into Oxy Cloud ({@link fetchAndStoreAvatar}).
   * A method so the mirror path and its callers reach it through the service.
   */
  async downloadAndStoreAvatar(
    avatarUrl: string,
    existingAvatarFileId?: string,
    conditional?: { etag?: string; lastModified?: string },
    ownerUserId = FEDERATION_SYSTEM_USER,
  ): Promise<AvatarDownloadResult> {
    return fetchAndStoreAvatar(avatarUrl, existingAvatarFileId, conditional, ownerUserId);
  }

  /**
   * Mirror a federated user's source picture into Oxy Cloud — the ONE way a
   * federated `users.avatar` gets a value. Never persists anything itself; the
   * caller writes `fileId` or, on failure, keeps the previous mirror (or none).
   *
   * When the source URL fails PERMANENTLY for an instagram.com account (the
   * bridge served a signed Meta CDN URL that has expired, or any 4xx) and the
   * Instagram Graph credentials are configured, a fresh `profile_picture_url` is read
   * through Business Discovery — under its own result cache, cooldown and call
   * budget — and mirrored instead. A personal account is invisible to Business
   * Discovery, so it simply has no picture until the bridge serves a live one.
   */
  async mirrorFederatedAvatar(
    userId: string,
    avatarUrl: string,
    existingAvatarFileId?: string,
    conditional?: { etag?: string; lastModified?: string },
  ): Promise<AvatarDownloadResult> {
    const stored = await this.downloadAndStoreAvatar(
      avatarUrl,
      existingAvatarFileId,
      conditional,
      userId,
    );
    if (stored.fileId || stored.notModified || stored.failure !== 'permanent') return stored;
    const graphAvatarUrl = await freshInstagramGraphAvatarUrl(userId, avatarUrl);
    if (!graphAvatarUrl) return stored;
    const fallback = await this.downloadAndStoreAvatar(
      graphAvatarUrl,
      existingAvatarFileId,
      undefined,
      userId,
    );
    if (!fallback.fileId) return stored;
    logger.info('Federated avatar mirrored from Instagram Graph after the source picture failed', {
      userId,
    });
    // The validators describe the Graph URL's bytes, not the bridge URL a later
    // conditional request is sent to, so none are carried forward.
    return { fileId: fallback.fileId, notModified: false, source: 'instagram_graph' };
  }

  /**
   * Hand back a cached federated row without blocking on remote I/O. Schedules a
   * background refresh when the record is stale or its avatar still needs work.
   */
  private async returnCachedFederatedRow(
    existing: AccountDocument,
    handleForRefresh: string,
  ): Promise<AccountDocument> {
    // Archived actors (410-Gone tombstones) stay cached for follow-graph /
    // audit continuity but must not be refreshed or re-surfaced as live.
    if (existing.accountStatus === 'archived') {
      return existing;
    }

    const updatedAt = existing.updatedAt;
    const isStale = !(updatedAt instanceof Date) || Date.now() - updatedAt.getTime() >= STALE_MS;
    // Anything but a file id (a legacy remote URL) is a mirror still owed.
    const avatarNeedsDownload =
      typeof existing.avatar === 'string' &&
      existing.avatar.length > 0 &&
      !isAvatarFileId(existing.avatar);
    const avatarFileMissing =
      !isStale && !avatarNeedsDownload ? !(await storedAvatarExists(existing.avatar)) : false;

    if (isStale || avatarNeedsDownload || avatarFileMissing) {
      this.scheduleBackgroundRefresh(existing, handleForRefresh);
    }

    return existing;
  }

  /**
   * Full pipeline: resolve a fediverse handle to an Oxy user.
   *
   * Fast + eventually-fresh (Bluesky-style):
   * 1. If a cached federated user exists, RETURN IT IMMEDIATELY — never block
   *    on remote I/O when we already have a row. If that row is stale (older
   *    than {@link STALE_MS}) or still has a raw-URL avatar that needs
   *    downloading, kick off a fire-and-forget background refresh that replaces
   *    avatar/name/bio in place, but still return the cached record now.
   * 2. If NO cached row exists, do the first-time blocking fetch:
   *    WebFinger → fetch actor profile (HTTP Signature) → download avatar →
   *    upsert as type=federated → return.
   */
  async resolveAndUpsert(handle: string): Promise<AccountDocument | null> {
    const cleaned = this.normalizeExternalHandle(handle);
    if (!cleaned) return null;
    const domain = domainFromHandle(cleaned);
    if (!domain || isOwnFederationDomain(domain)) return null;
    const knownId = await lookupExternalIdentity(cleaned);
    if (knownId) {
      const known = await userService.readAccountDocument(knownId);
      if (known) {
        if (
          known.federation.actorUri &&
          (await this.deferUnverifiedBridgeActor(known.federation.actorUri))
        ) {
          return null;
        }
        return this.returnCachedFederatedRow(known, cleaned);
      }
    }
    // Discovering an unknown handle is the one remote round trip a lookup has to
    // wait for: there is nothing stored to serve instead. A handle that just
    // failed it is not retried by every lookup that follows — unless the failure
    // came from a source whose "not found" is no evidence of absence: remembering
    // that answered "not found" for an account that exists, for five minutes, to
    // every profile view and search (elctrixr@x.com, 2026-11-04).
    if (await unresolvableHandles.has(cleaned)) return null;
    const resolved = await this.resolveExternalIdentity({ handle: cleaned });
    if (!resolved) {
      if (!missIsInconclusive(cleaned)) await unresolvableHandles.remember(cleaned);
      return null;
    }
    return userService.readAccountDocument(resolved.externalIdentity.userId);
  }

  /**
   * Whether a stored row is a bridge migration row that has not yet been
   * through first discovery ({@link needsBridgeCanonicalization}). Such a row is
   * never served before that discovery, and a READ never performs it: discovery
   * is a remote fetch plus a registry write, which can take seconds (bird.makeup
   * answers 404 transiently and is retried for two) and can refuse with a
   * conflict. So this schedules it in the background and the caller answers
   * "not found" until it has landed.
   */
  async deferUnverifiedBridgeActor(actorUri: string): Promise<boolean> {
    if (!(await this.needsBridgeCanonicalization(actorUri))) return false;
    this.scheduleSourceVerification(actorUri);
    return true;
  }

  /**
   * Fire-and-forget verification of one source actor: the first discovery of a
   * legacy bridge actor, or the re-verification of a stale stored one. Runs
   * under the same per-actor storm guard as {@link scheduleBackgroundRefresh}
   * (the two share it, so a refresh and a verification of one actor never
   * overlap). NEVER awaits and NEVER throws.
   */
  private scheduleSourceVerification(actorUri: string, transportAcct?: string): void {
    if (!claimRefreshSlot(actorUri)) return;
    void this.resolveExternalActorIdentity(actorUri, transportAcct)
      .catch((err) => {
        logger.warn(
          `Background source verification failed for ${actorUri}: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        releaseRefreshSlot(actorUri);
      });
  }

  /**
   * Fire-and-forget scheduler for {@link refreshFederatedUser}.
   *
   * Storm guard ({@link claimRefreshSlot}): a given actor is refreshed at most
   * once concurrently and at most once per refresh interval. The refresh key is
   * the actor URI when known, otherwise the lowercased handle. This method NEVER
   * awaits and NEVER throws — a rejected refresh is caught and logged so it can't
   * surface as an unhandled rejection or crash the process.
   */
  private scheduleBackgroundRefresh(existing: AccountDocument, handle: string): void {
    if (existing.accountStatus === 'archived') {
      return;
    }

    const key = existing.federation.actorUri || handle.toLowerCase();

    if (!claimRefreshSlot(key)) return;

    void this.refreshFederatedUser(existing, handle)
      .catch((err) => {
        logger.warn(
          `Background federated refresh failed for ${key}: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        releaseRefreshSlot(key);
      });
  }

  /**
   * Fire-and-forget scheduler that moves a remote avatar download OFF the
   * request path (used by PUT /users/resolve). The caller upserts the user and
   * returns immediately; this replaces the user's `avatar` file id once the
   * download completes and invalidates the user cache.
   *
   * Throttle ({@link claimAvatarRefreshSlot}): at most one download per user
   * concurrently and at most one per {@link AVATAR_REFRESH_MIN_INTERVAL_MS} per
   * process. The persisted
   * `federation.lastAvatarFetchedAt`, re-read inside {@link downloadAvatarForUser},
   * is the cross-restart authority. This method NEVER awaits and NEVER throws —
   * a rejection is caught and logged so it can't surface as an unhandled
   * rejection.
   *
   * @param userId               - The upserted user's id (resolved fresh inside).
   * @param remoteAvatarUrl      - The http(s) avatar URL to download.
   * @param existingAvatarFileId - Current stored avatar file id (deleted on replace).
   * @param opts.force           - When true (a `refresh`/`forceAvatarRefresh`
   *                               request), re-download even if a stored file id
   *                               already exists — still subject to the throttle.
   */
  scheduleAvatarRefresh(
    userId: string,
    remoteAvatarUrl: string,
    existingAvatarFileId: string | undefined,
    opts: { force: boolean },
  ): void {
    if (!claimAvatarRefreshSlot(userId)) return;

    void this.downloadAvatarForUser(userId, remoteAvatarUrl, existingAvatarFileId, opts)
      .catch((err) => {
        logger.warn(
          `Background avatar refresh failed for ${userId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        releaseAvatarRefreshSlot(userId);
      });
  }

  /**
   * Background worker for {@link scheduleAvatarRefresh}. Resolves the user fresh
   * from its id so it reads the authoritative persisted throttle clock and
   * conditional-request validators, downloads the avatar (conditionally), and
   * persists the result. Wraps its whole body so a rejection can never escape
   * the fire-and-forget caller — all failures are logged.
   */
  private async downloadAvatarForUser(
    userId: string,
    remoteAvatarUrl: string,
    existingAvatarFileId: string | undefined,
    opts: { force: boolean },
  ): Promise<void> {
    try {
      // Four named columns, not `select()`: `users` carries protected columns
      // (the raw phone number, the contact-discovery hashes, the refresh
      // token) that a background avatar worker has no business loading.
      const [user] = await getDb()
        .select({
          avatar: users.avatar,
          lastAvatarFetchedAt: users.federationLastAvatarFetchedAt,
          avatarETag: users.federationAvatarETag,
          avatarLastModified: users.federationAvatarLastModified,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!user) {
        logger.warn(`Background avatar refresh: user ${userId} not found`);
        return;
      }

      // `storedAvatar` is already a file id or nothing — the helper guarantees it —
      // so the question is simply whether there is one.
      const storedAvatar =
        storedAvatarFileId(user.avatar) ?? storedAvatarFileId(existingAvatarFileId);
      const alreadyHasFileId = storedAvatar !== undefined;

      // Persisted authority: skip a forced re-download inside the throttle window.
      // The in-memory guard in scheduleAvatarRefresh handles the common in-process
      // burst; this catches forced refreshes across process restarts.
      const lastFetched = user.lastAvatarFetchedAt;
      if (
        opts.force &&
        alreadyHasFileId &&
        lastFetched &&
        Date.now() - lastFetched.getTime() < AVATAR_REFRESH_MIN_INTERVAL_MS
      ) {
        return;
      }

      // Without a force flag, never re-download once we hold a stored file id.
      if (!opts.force && alreadyHasFileId) {
        return;
      }

      // With NO stored file, the clock is the retry policy: a mirror that failed
      // less than the throttle window ago is not retried yet. Every resolve of a
      // user without a picture schedules one, and a dead source (an expired Meta
      // CDN signature) would otherwise be retried — and fall back to a Graph
      // call — on each of them.
      if (
        !alreadyHasFileId &&
        lastFetched &&
        Date.now() - lastFetched.getTime() < AVATAR_REFRESH_MIN_INTERVAL_MS
      ) {
        return;
      }

      const stored = await this.mirrorFederatedAvatar(userId, remoteAvatarUrl, storedAvatar, {
        // The conditional-request validators are NULL when never fetched;
        // `downloadAndStoreAvatar` reads them as "send no If-None-Match".
        etag: user.avatarETag ?? undefined,
        lastModified: user.avatarLastModified ?? undefined,
      });

      const setFields: Partial<typeof users.$inferInsert> = {
        federationLastAvatarFetchedAt: new Date(),
      };

      if (stored.notModified) {
        // Host says our copy is current — only advance the fetch clock.
        await getDb().update(users).set(setFields).where(eq(users.id, userId));
        userCache.invalidate(userId);
        return;
      }

      if (!stored.fileId) {
        // Download failed — keep the previous MIRROR (a file id), never a remote
        // URL in its place, and advance the clock so a forced refresh can't
        // hammer a broken remote every request. No stored file means no picture,
        // which clients render as the default avatar.
        await persistFederatedAvatar(
          userId,
          { failed: stored.reason ?? 'unexpected', permanent: stored.failure === 'permanent' },
          setFields,
        );
        userCache.invalidate(userId);
        logger.warn(
          `Background avatar refresh: download failed for ${userId} (keeping existing mirror)`,
          { failure: stored.failure, reason: stored.reason },
        );
        return;
      }

      // Validators belong to the bytes just stored; absent ones replace stale ones.
      setFields.federationAvatarETag = stored.etag ?? null;
      setFields.federationAvatarLastModified = stored.lastModified ?? null;

      await persistFederatedAvatar(
        userId,
        { fileId: stored.fileId, color: stored.color },
        setFields,
      );

      // CRITICAL: every path that mutates user state must invalidate the cache,
      // otherwise getUserBySession serves stale in-memory data and silently
      // reverts this update.
      userCache.invalidate(userId);

      logger.info(`Background-refreshed federated avatar for ${userId}`);
    } catch (err) {
      // Defensive: this worker must never throw out of the fire-and-forget
      // caller. The scheduler also has a .catch, but we log here with context too.
      logger.error(
        `Background avatar refresh threw for ${userId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Re-fetch a cached federated actor in the background through
   * {@link resolveExternalActorIdentity}, the one path that dispatches by source
   * (atproto DID, Instagram Graph, ActivityPub), registers the profile, refreshes
   * the Meta proof and invalidates the cache. The avatar is re-checked by the
   * avatar worker, which replays the stored conditional-request validators.
   * Wraps its whole body so a rejection can never escape the caller.
   *
   * @param existing - The cached federated user to refresh.
   * @param handle   - The lowercased handle, used to re-WebFinger if no actorUri.
   */
  private async refreshFederatedUser(existing: AccountDocument, handle: string): Promise<void> {
    if (existing.accountStatus === 'archived') {
      return;
    }

    try {
      const actorUri = existing.federation.actorUri || (await this.resolveWebFinger(handle));
      if (!actorUri) {
        logger.warn(`Background refresh: could not resolve actor URI for ${handle}`);
        return;
      }
      const refreshed = await this.resolveExternalActorIdentity(actorUri, handle, {
        forceAvatarRefresh: true,
      });
      if (!refreshed) {
        logger.warn(`Background refresh: ${actorUri} did not resolve`);
        return;
      }
      logger.info(
        `Background-refreshed federated user ${existing.username || handle} (${actorUri})`,
      );
    } catch (err) {
      // Defensive: refreshFederatedUser must never throw out of the
      // fire-and-forget caller. The scheduler also has a .catch, but we log here
      // with full context too.
      logger.error(
        `Background refresh threw for ${handle} (${existing._id}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export const federationService = new FederationService();
export default federationService;
