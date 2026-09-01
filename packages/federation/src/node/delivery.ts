/**
 * Outbound activity delivery + the follow lifecycle (Follow / Undo(Follow) /
 * Accept(Follow)) and the `Update(Person)` actor rebroadcast.
 *
 * The delivery TRANSPORT (sign → SSRF-safe POST → BullMQ / durable fallback queue),
 * the shared-inbox dedup fan-out, and the follow-protocol activity shapes are the
 * SAME across every Oxy app, so they live here — behaviour-identical to Mention's
 * former `FollowService` delivery half. Everything app-specific is injected:
 *
 *  - private-key CUSTODY stays behind the {@link DeliveryKeys} adapter (Mention:
 *    oxy-api `/federation/sign` + `/federation/public-key`); the key never enters
 *    this package,
 *  - the SSRF-safe single-hop POST + the BullMQ enqueue + the durable
 *    fallback are the {@link DeliveryTransport}, so the delivery policy stays in
 *    one place (Mention's `fetchUpstreamSingleHop` + `FederationDeliveryQueue`),
 *  - the AP-specific `FederatedActor` / `FederatedFollow` rows stay in the app DB
 *    behind the {@link DeliveryActorStore} / {@link DeliveryFollowStore} adapters
 *    ("bring your own store" — no data move),
 *  - the actor cache refresh (for a follow whose target inbox is not yet known),
 *    the consent gate, the actor-profile resolver, the banner, and the local-actor
 *    builder are all injected.
 *
 * The CONTENT federate methods (build the Note / boost / like) STAY in the app and
 * call `deliverToFollowers` / `deliverActivity` / `queueDelivery` here.
 */

import type { AccountKind } from '@oxyhq/contracts';
import { AP_CONTEXT } from '../apContext';
import { signRequest, type HttpSignatureSigner } from '../httpSignature';
import type { UrlBuilders } from '../urls';
import type { LocalActorBuilder } from '../actorObject';

/** Total time budget for a single delivery POST (connect + response headers). */
const DELIVER_ACTIVITY_TIMEOUT_MS = 15000;
/** How many bytes of a failed-delivery response body are read for the debug log. */
const DELIVERY_RESPONSE_PREVIEW_MAX_BYTES = 1024;

/** The ActivityStreams public collection — the `to` addressee of a public activity. */
const AP_PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

/** Minimal logging sink the delivery service writes to. */
export interface DeliveryLogger {
  debug(message: string, detail?: unknown): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string, detail?: unknown): void;
}

/**
 * Private-key custody for outbound signing. The private key NEVER enters this
 * package — `getPublicKey` returns only the actor's public keyId (to name the
 * signature) and `sign` delegates the RSA-SHA256 signing (Mention → oxy-api).
 */
export interface DeliveryKeys {
  getPublicKey(username: string): Promise<{ keyId: string; publicKeyPem: string }>;
  sign: HttpSignatureSigner;
}

/** A bounded, destroyable byte stream — the raw single-hop delivery response body. */
export interface DeliveryResponseStream extends AsyncIterable<Buffer | Uint8Array> {
  destroy(): void;
}

/** The result of one SSRF-safe single-hop delivery POST (redirects NOT followed). */
export interface DeliverSingleHopResult {
  response: DeliveryResponseStream;
  status: number;
}

/** Per-request options handed to the injected single-hop delivery transport. */
export interface DeliverSingleHopInit {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
  headersTimeoutMs: number;
}

/**
 * An SSRF-safe single-hop POST: validates + IP-pins the URL and returns the raw
 * response WITHOUT following redirects. Mention adapts its `@oxyhq/core/server`-
 * backed `fetchUpstreamSingleHop` into this shape.
 */
export type DeliverSingleHop = (url: string, init: DeliverSingleHopInit) => Promise<DeliverSingleHopResult>;

/** A durable-delivery job body (BullMQ + the fallback queue share this shape). */
export interface DeliveryQueueJob {
  activityJson: Record<string, unknown>;
  targetInbox: string;
  senderOxyUserId: string;
}

/**
 * The durable-delivery fallback (written when BullMQ is unavailable).
 *
 * App-supplied, like every other store in this package: the engine never names
 * a database. Mention backs it with Postgres; the method names below are the
 * ones its original Mongoose collection exposed and are kept only so the
 * adapter shape stays stable for consumers.
 */
export interface DeliveryFallbackQueue {
  /** Insert one fallback delivery row (`queueDelivery`). */
  create(job: DeliveryQueueJob & { nextAttemptAt: Date }): Promise<unknown>;
  /** Insert many fallback delivery rows in one write (`deliverToFollowers`). */
  insertMany(jobs: Array<DeliveryQueueJob & { nextAttemptAt: Date }>): Promise<unknown>;
}

/** The delivery transport: BullMQ enqueue with a durable app-supplied fallback. */
export interface DeliveryTransport {
  /**
   * Enqueue one durable delivery. Resolves `false` when the queue is unavailable
   * (Redis not configured) so the engine falls back to {@link DeliveryFallbackQueue}.
   * May REJECT (the engine treats a rejection as `false` and falls back).
   */
  enqueueDelivery(job: DeliveryQueueJob): Promise<boolean>;
  fallbackQueue: DeliveryFallbackQueue;
}

/**
 * The delivery-relevant fields of a stored remote actor. `TActor` (the app's own
 * `FederatedActor` shape) extends this; the engine reads only these fields and
 * hands the FULL record back to `actorRefresh.refreshActorInBackground`.
 */
export interface DeliveryActorFields {
  _id?: unknown;
  uri: string;
  sharedInboxUrl?: string | null;
  inboxUrl?: string | null;
  manuallyApprovesFollowers?: boolean;
}

/** Bring-your-own-store: the AP actor cache stays in the app DB behind this adapter. */
export interface DeliveryActorStore<TActor extends DeliveryActorFields> {
  /** One cached actor by uri (`resolveActorInbox` / `sendFollow` / `sendUndoFollow` / `sendAccept`). */
  findActorByUri(uri: string): Promise<TActor | null>;
  /** Inbox fields for many actor uris (`deliverToFollowers`, step 2). */
  findActorInboxesByUris(uris: string[]): Promise<Array<Pick<DeliveryActorFields, 'sharedInboxUrl' | 'inboxUrl'>>>;
}

/** Bring-your-own-store: the AP follow records stay in the app DB behind this adapter. */
export interface DeliveryFollowStore {
  /** Accepted inbound followers' remote actor uris (`deliverToFollowers`, step 1). */
  listAcceptedInboundFollowerActorUris(localOxyUserId: string): Promise<string[]>;
  /** Upsert an outbound pending follow with its activity id (`sendFollow`). */
  upsertOutboundPending(localOxyUserId: string, remoteActorUri: string, activityId: string): Promise<void>;
  /** The outbound follow row for `(localOxyUserId, remoteActorUri)` (`sendUndoFollow`). */
  findOutbound(localOxyUserId: string, remoteActorUri: string): Promise<{ _id: unknown; activityId?: string } | null>;
  /** Delete a follow row by id (`sendUndoFollow`). */
  deleteById(id: unknown): Promise<void>;
}

/** The actor-cache refresh the follow path uses when a target inbox is not yet known. */
export interface DeliveryActorRefresh<TActor extends DeliveryActorFields> {
  /** Fire-and-forget full-actor refresh (keeps a followee's inbox/profile current). */
  refreshActorInBackground(actorUri: string, existing?: TActor): void;
  /** Blocking actor fetch to resolve an inbox when none is cached (`queueFollowOnceActorKnown`). */
  fetchRemoteActor(actorUri: string): Promise<TActor | null>;
}

/** The consent gate — only `federateActorUpdate` gates outbound delivery on it. */
export interface DeliveryConsent {
  isSharingEnabled(oxyUserId: string): Promise<boolean>;
}

/** The Oxy profile fields the actor `Update` rebroadcast reads. */
export interface DeliveryActorProfile {
  name?: { displayName?: string | null } | null;
  bio?: string | null;
  avatar?: string | null;
  createdAt?: string | null;
  /**
   * Account-graph classification — decides the actor `type`. It MUST travel with
   * the rebroadcast: an `Update` carrying a different `type` from the one the GET
   * route serves is exactly the drift the shared builder exists to prevent, and
   * on a type change it is also the migration vehicle (a follower's instance
   * adopts the new type from this push rather than waiting out its own actor
   * staleness window).
   */
  kind?: AccountKind | null;
}

/** Resolve a local username to its Oxy profile (for the `Update(Person)` rebroadcast). */
export interface DeliveryIdentity {
  resolveUserByUsername(username: string): Promise<DeliveryActorProfile | null>;
}

/** The app-owned profile banner (Mention: `UserSettings.profileHeaderImage`). */
export interface DeliveryProfile {
  getBanner(oxyUserId: string): Promise<string | null>;
}

/** The result shape of the injected SSRF pre-check for a durable inbox enqueue. */
export interface SafeUrlVerdict {
  ok: boolean;
  reason?: string;
}

/** Adapters + config a {@link DeliveryService} is built from. */
export interface DeliveryServiceConfig<TActor extends DeliveryActorFields> {
  /** Whether federation is enabled (gates `sendFollow`/`sendUndoFollow`/`federateActorUpdate`). */
  federationEnabled: boolean;
  /** User-Agent presented to remote inboxes. */
  userAgent: string;
  /** The AP content type (`application/activity+json`) used for delivery headers. */
  apContentType: string;
  /** Private-key custody + public keyId lookup. */
  keys: DeliveryKeys;
  /** Per-instance URL builders (actor URL for the follow/update activities). */
  urls: UrlBuilders;
  /** SSRF-safe single-hop delivery POST (does NOT follow redirects). */
  deliverSingleHop: DeliverSingleHop;
  /** SSRF pre-check for a durable inbox enqueue (never queue a delivery to an unsafe URL). */
  assertSafeInboxUrl(url: string): Promise<SafeUrlVerdict>;
  /** BullMQ enqueue + the durable fallback queue. */
  transport: DeliveryTransport;
  /** The AP actor cache store. */
  store: DeliveryActorStore<TActor>;
  /** The AP follow-record store. */
  follows: DeliveryFollowStore;
  /** Actor-cache refresh for the follow path. */
  actorRefresh: DeliveryActorRefresh<TActor>;
  /** The fediverse-sharing consent gate (used by `federateActorUpdate` only). */
  consent: DeliveryConsent;
  /** Resolve a local username to its Oxy profile (`federateActorUpdate`). */
  identity: DeliveryIdentity;
  /** App-owned profile banner (`federateActorUpdate`). */
  profile: DeliveryProfile;
  /** The single local-actor builder (shared with the actor GET route). */
  buildLocalActorObject: LocalActorBuilder;
  /** Diagnostics sink. */
  logger: DeliveryLogger;
  /**
   * The app's per-instance domain policy (`DomainPolicy.isBlockedDomain`) — the
   * same predicate inbound dispatch and actor resolution use. Outbound delivery
   * must refuse blocked origins symmetrically: a domain blocked inbound must not
   * keep receiving Follow/Undo/Accept or follower fan-out via a cached inbox.
   */
  isBlockedDomain(host: string): boolean;
}

/** Read a bounded prefix of a failed-delivery response body for the debug log. */
async function readResponsePreview(response: DeliveryResponseStream): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  try {
    for await (const chunk of response) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.byteLength;
      chunks.push(buffer);
      if (totalBytes >= DELIVERY_RESPONSE_PREVIEW_MAX_BYTES) break;
    }
  } catch {
    return '';
  } finally {
    response.destroy();
  }

  return Buffer.concat(chunks).toString('utf8', 0, DELIVERY_RESPONSE_PREVIEW_MAX_BYTES);
}

/** The outbound delivery + follow-lifecycle service. */
export interface DeliveryService {
  /** Deliver an activity to one remote inbox, signed with the sender's key. */
  deliverActivity(
    activity: Record<string, unknown>,
    targetInbox: string,
    senderOxyUserId: string,
    senderUsername: string,
  ): Promise<boolean>;
  /** Queue one activity for durable delivery (BullMQ, fallback queue). */
  queueDelivery(
    activity: Record<string, unknown>,
    targetInbox: string,
    senderOxyUserId: string,
  ): Promise<void>;
  /** Resolve a remote actor's delivery inbox (shared preferred) from the store. */
  resolveActorInbox(actorUri: string | undefined): Promise<string | undefined>;
  /** Deliver to all accepted inbound followers plus `options.extraInboxes` (deduped by shared inbox). */
  deliverToFollowers(
    activity: Record<string, unknown>,
    senderOxyUserId: string,
    senderUsername: string,
    options?: { extraInboxes?: string[] },
  ): Promise<void>;
  /** Send a Follow activity to a remote actor (records the outbound follow, delivers/queues). */
  sendFollow(
    localOxyUserId: string,
    localUsername: string,
    remoteActorUri: string,
  ): Promise<{ success: boolean; pending: boolean }>;
  /** Send an Undo(Follow) to a remote actor (removes the local follow first). */
  sendUndoFollow(
    localOxyUserId: string,
    localUsername: string,
    remoteActorUri: string,
  ): Promise<boolean>;
  /** Send an Accept(Follow) back to a remote actor. */
  sendAccept(
    localOxyUserId: string,
    localUsername: string,
    followActivityId: string,
    remoteActorUri: string,
  ): Promise<void>;
  /** Rebroadcast the FULL actor document as an Update(Person) to remote followers. */
  federateActorUpdate(actorOxyUserId: string, username: string): Promise<void>;
}

/** Build the outbound delivery + follow-lifecycle service from an app's adapters. */
export function createDeliveryService<TActor extends DeliveryActorFields>(
  config: DeliveryServiceConfig<TActor>,
): DeliveryService {
  const { logger, urls } = config;

  /** Lowercased host of an absolute URL, or null when unparseable (fails closed). */
  function urlHost(url: string): string | null {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return null;
    }
  }

  /** True when `url`'s host is missing or on the blocked-domain policy. */
  function isBlockedUrl(url: string): boolean {
    const host = urlHost(url);
    return host === null || config.isBlockedDomain(host);
  }

  async function deliverActivity(
    activity: Record<string, unknown>,
    targetInbox: string,
    senderOxyUserId: string,
    senderUsername: string,
  ): Promise<boolean> {
    if (isBlockedUrl(targetInbox)) {
      logger.warn(`[FedDeliver] refusing outbound delivery to blocked inbox ${targetInbox}`);
      return false;
    }
    try {
      const { keyId } = await config.keys.getPublicKey(senderUsername);
      const body = JSON.stringify(activity);
      const sigHeaders = await signRequest(config.keys.sign, keyId, 'POST', targetInbox, body);

      const allHeaders: Record<string, string> = {
        'Content-Type': config.apContentType,
        'Content-Length': String(Buffer.byteLength(body, 'utf-8')),
        'User-Agent': config.userAgent,
        Accept: config.apContentType,
        ...sigHeaders,
      };

      logger.debug(`[FedDeliver] POST ${targetInbox} body=${body} sig-headers=${sigHeaders.Signature?.match(/headers="([^"]+)"/)?.[1]}`);

      const { response, status } = await config.deliverSingleHop(targetInbox, {
        method: 'POST',
        headers: allHeaders,
        body,
        signal: AbortSignal.timeout(DELIVER_ACTIVITY_TIMEOUT_MS),
        headersTimeoutMs: DELIVER_ACTIVITY_TIMEOUT_MS,
      });

      if ((status >= 200 && status < 300) || status === 202) {
        response.destroy();
        return true;
      }

      const responseBody = await readResponsePreview(response);
      logger.debug(`Activity delivery failed to ${targetInbox}: ${status} body=${responseBody.slice(0, 500)}`);
      return false;
    } catch (err) {
      logger.debug(`Activity delivery error to ${targetInbox}:`, err);
      return false;
    }
  }

  async function queueDelivery(
    activity: Record<string, unknown>,
    targetInbox: string,
    senderOxyUserId: string,
  ): Promise<void> {
    if (isBlockedUrl(targetInbox)) {
      logger.warn(`[FedDeliver] not queueing delivery to blocked inbox ${targetInbox}`);
      return;
    }
    // Defense-in-depth: never enqueue a durable delivery to an unsafe inbox URL.
    // The per-send POST is already SSRF-pinned, but a blocked URL would otherwise
    // sit in the queue and be retried forever.
    const guard = await config.assertSafeInboxUrl(targetInbox);
    if (!guard.ok) {
      logger.warn(`[FedDeliver] not queueing unsafe inbox URL ${targetInbox}: ${guard.reason}`);
      return;
    }

    const enqueued = await config.transport
      .enqueueDelivery({ activityJson: activity, targetInbox, senderOxyUserId })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`[FedDeliver] enqueue failed for ${targetInbox}, falling back to the durable queue: ${message}`);
        return false;
      });

    if (enqueued) return;

    await config.transport.fallbackQueue.create({
      activityJson: activity,
      targetInbox,
      senderOxyUserId,
      nextAttemptAt: new Date(),
    });
  }

  async function resolveActorInbox(actorUri: string | undefined): Promise<string | undefined> {
    if (!actorUri) return undefined;
    const actor = await config.store.findActorByUri(actorUri);
    if (!actor) return undefined;
    return actor.sharedInboxUrl ?? actor.inboxUrl ?? undefined;
  }

  async function deliverToFollowers(
    activity: Record<string, unknown>,
    senderOxyUserId: string,
    senderUsername: string,
    options: { extraInboxes?: string[] } = {},
  ): Promise<void> {
    const actorUris = await config.follows.listAcceptedInboundFollowerActorUris(senderOxyUserId);
    const actors = actorUris.length > 0 ? await config.store.findActorInboxesByUris(actorUris) : [];

    // Group by shared inbox to avoid duplicate deliveries. Follower inboxes
    // first, then the explicit targets — the shared `seen` set dedupes an
    // explicit inbox that an instance already receives as a follower.
    const seen = new Set<string>();
    const inboxes: string[] = [];
    for (const actor of actors) {
      const inbox = actor.sharedInboxUrl || actor.inboxUrl;
      if (inbox && !seen.has(inbox)) {
        seen.add(inbox);
        inboxes.push(inbox);
      }
    }
    for (const inbox of options.extraInboxes ?? []) {
      if (inbox && !seen.has(inbox)) {
        seen.add(inbox);
        inboxes.push(inbox);
      }
    }
    if (inboxes.length === 0) return;

    // Durable path: enqueue one BullMQ delivery per shared inbox (deduped per
    // inbox + activity id). When the queue is unavailable fall back to a single
    // batch insert into the durable queue for the inboxes that were not enqueued.
    const now = new Date();
    const durableFallback: Array<DeliveryQueueJob & { nextAttemptAt: Date }> = [];

    for (const inbox of inboxes) {
      if (isBlockedUrl(inbox)) {
        logger.warn(`[FedDeliver] not queueing delivery to blocked inbox ${inbox}`);
        continue;
      }
      const guard = await config.assertSafeInboxUrl(inbox);
      if (!guard.ok) {
        logger.warn(`[FedDeliver] not queueing unsafe inbox URL ${inbox}: ${guard.reason}`);
        continue;
      }

      const enqueued = await config.transport
        .enqueueDelivery({ activityJson: activity, targetInbox: inbox, senderOxyUserId })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn(`[FedDeliver] follower enqueue failed for ${inbox}, falling back to the durable queue: ${message}`);
          return false;
        });

      if (!enqueued) {
        durableFallback.push({ activityJson: activity, targetInbox: inbox, senderOxyUserId, nextAttemptAt: now });
      }
    }

    if (durableFallback.length > 0) {
      await config.transport.fallbackQueue.insertMany(durableFallback);
    }
  }

  /**
   * Resolve the target actor's inbox in the background and queue the Follow
   * activity for delivery once known. Fire-and-forget: returns synchronously and
   * never blocks the caller on remote I/O.
   */
  function queueFollowOnceActorKnown(
    activity: Record<string, unknown>,
    canonicalUri: string,
    localOxyUserId: string,
    remoteActorUri: string,
  ): void {
    void (async () => {
      try {
        let actor = await config.store.findActorByUri(canonicalUri);
        if (!actor?.inboxUrl) {
          actor = await config.actorRefresh.fetchRemoteActor(remoteActorUri);
        }
        const inbox = actor?.sharedInboxUrl ?? actor?.inboxUrl;
        if (inbox && !isBlockedUrl(inbox) && !isBlockedUrl(remoteActorUri)) {
          await queueDelivery(activity, inbox, localOxyUserId);
        } else {
          logger.warn(`[FedSync] could not resolve inbox to deliver Follow to ${remoteActorUri}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`[FedSync] deferred follow delivery setup failed for ${remoteActorUri}: ${message}`);
      }
    })();
  }

  async function sendFollow(
    localOxyUserId: string,
    localUsername: string,
    remoteActorUri: string,
  ): Promise<{ success: boolean; pending: boolean }> {
    if (!config.federationEnabled) return { success: false, pending: false };
    if (isBlockedUrl(remoteActorUri)) {
      logger.warn(`[FedDeliver] refusing outbound Follow to blocked origin ${remoteActorUri}`);
      return { success: false, pending: false };
    }

    // Never block the follow request on a remote actor fetch. Use whatever is
    // cached; if the actor is unknown locally we still record the follow and
    // queue the Follow activity, then refresh the actor in the background.
    const cached = await config.store.findActorByUri(remoteActorUri);

    // Always refresh the actor in the background so its inbox/profile stay
    // current (and so a missing actor gets resolved for delivery shortly).
    config.actorRefresh.refreshActorInBackground(remoteActorUri, cached ?? undefined);

    const canonicalUri = cached?.uri ?? remoteActorUri;
    const localActorUri = urls.actor(localUsername);
    // Use the actor _id when known, otherwise a stable hash of the URI so the
    // activity ID is deterministic across retries before the actor is cached.
    const activityIdSuffix = cached?._id
      ? String(cached._id)
      : encodeURIComponent(canonicalUri);
    const activityId = `${localActorUri}/follows/${activityIdSuffix}`;

    // Create or update the follow record
    await config.follows.upsertOutboundPending(localOxyUserId, canonicalUri, activityId);

    const activity: Record<string, unknown> = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: activityId,
      type: 'Follow',
      actor: localActorUri,
      object: canonicalUri,
    };

    // If we know the inbox, attempt delivery in the background; otherwise queue
    // for the delivery worker, which resolves the inbox once the actor lands.
    const targetInbox = cached?.sharedInboxUrl ?? cached?.inboxUrl;
    if (targetInbox && !isBlockedUrl(targetInbox)) {
      void deliverActivity(activity, targetInbox, localOxyUserId, localUsername)
        .then((delivered) => {
          if (!delivered) return queueDelivery(activity, targetInbox, localOxyUserId);
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn(`[FedSync] background follow delivery failed for ${canonicalUri}: ${message}`);
        });
    } else {
      // No cached inbox yet — resolve the actor's inbox in the background and
      // queue the Follow for delivery once known. Reports success optimistically;
      // the delivery worker retries the queued delivery. Never blocks the caller.
      queueFollowOnceActorKnown(activity, canonicalUri, localOxyUserId, remoteActorUri);
    }

    return { success: true, pending: cached?.manuallyApprovesFollowers ?? false };
  }

  async function sendUndoFollow(
    localOxyUserId: string,
    localUsername: string,
    remoteActorUri: string,
  ): Promise<boolean> {
    if (!config.federationEnabled) return false;

    const follow = await config.follows.findOutbound(localOxyUserId, remoteActorUri);
    if (!follow) return false;

    const actor = await config.store.findActorByUri(remoteActorUri);
    if (!actor) return false;

    const localActorUri = urls.actor(localUsername);

    const activity: Record<string, unknown> = {
      '@context': AP_CONTEXT,
      id: `${localActorUri}/follows/${actor._id}/undo`,
      type: 'Undo',
      actor: localActorUri,
      object: {
        id: follow.activityId,
        type: 'Follow',
        actor: localActorUri,
        object: remoteActorUri,
      },
    };

    // Remove the local follow immediately so the unfollow reflects in the UI,
    // then deliver the Undo in the background — never block the request on the
    // remote POST.
    await config.follows.deleteById(follow._id);

    // `inboxUrl` is schema-optional (atproto actors have none); an AP actor we
    // are sending Undo(Follow) to always has one. When neither inbox is known the
    // local follow is already removed — just skip the outbound delivery.
    const targetInbox = actor.sharedInboxUrl ?? actor.inboxUrl;
    if (targetInbox && !isBlockedUrl(targetInbox) && !isBlockedUrl(remoteActorUri)) {
      void deliverActivity(activity, targetInbox, localOxyUserId, localUsername)
        .then((delivered) => {
          if (!delivered) return queueDelivery(activity, targetInbox, localOxyUserId);
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn(`[FedSync] background undo-follow delivery failed for ${remoteActorUri}: ${message}`);
        });
    } else if (targetInbox) {
      logger.warn(`[FedDeliver] skipping Undo(Follow) delivery to blocked origin ${remoteActorUri}`);
    }

    return true;
  }

  async function sendAccept(
    localOxyUserId: string,
    localUsername: string,
    followActivityId: string,
    remoteActorUri: string,
  ): Promise<void> {
    const actor = await config.store.findActorByUri(remoteActorUri);
    if (!actor) return;
    // `inboxUrl` is schema-optional (atproto actors have none); an AP actor we
    // are sending Accept(Follow) to always has one. When neither inbox is known the
    // local follow is already removed — just skip the outbound delivery.
    const targetInbox = actor.sharedInboxUrl ?? actor.inboxUrl;
    if (!targetInbox) {
      logger.warn(`[FedSync] cannot send Accept(Follow) to ${remoteActorUri}: actor has no inbox`);
      return;
    }
    if (isBlockedUrl(targetInbox) || isBlockedUrl(remoteActorUri)) {
      logger.warn(`[FedDeliver] refusing Accept(Follow) delivery to blocked origin ${remoteActorUri}`);
      return;
    }

    const localActorUri = urls.actor(localUsername);

    const activity: Record<string, unknown> = {
      '@context': AP_CONTEXT,
      id: `${localActorUri}/accepts/${Date.now()}`,
      type: 'Accept',
      actor: localActorUri,
      object: {
        id: followActivityId,
        type: 'Follow',
        actor: remoteActorUri,
        object: localActorUri,
      },
    };

    const delivered = await deliverActivity(activity, targetInbox, localOxyUserId, localUsername);
    if (!delivered) {
      await queueDelivery(activity, targetInbox, localOxyUserId);
    }
  }

  async function federateActorUpdate(actorOxyUserId: string, username: string): Promise<void> {
    if (!config.federationEnabled) return;
    if (!(await config.consent.isSharingEnabled(actorOxyUserId))) return;

    try {
      const user = await config.identity.resolveUserByUsername(username);
      if (!user) {
        logger.warn(`[FedDeliver] cannot federate actor update for ${username}: user not resolvable`);
        return;
      }

      const publicKey = await config.keys.getPublicKey(username);
      const profileHeaderImage = await config.profile.getBanner(actorOxyUserId);

      // Canonical display name is owned by the Oxy API; fall back to the handle
      // when absent (never recompose from name parts).
      const displayName = user.name?.displayName || username;

      const actorObject = config.buildLocalActorObject({
        username,
        displayName,
        kind: user.kind,
        bio: user.bio,
        avatar: user.avatar,
        profileHeaderImage,
        publicKey,
        createdAt: user.createdAt,
      });

      const actor = urls.actor(username);
      const now = new Date();
      const activity: Record<string, unknown> = {
        '@context': AP_CONTEXT,
        id: `${actor}#updates/${now.getTime()}`,
        type: 'Update',
        actor,
        updated: now.toISOString(),
        to: [AP_PUBLIC],
        cc: [`${actor}/followers`],
        object: actorObject,
      };

      await deliverToFollowers(activity, actorOxyUserId, username);
    } catch (err) {
      logger.error('Failed to federate actor update:', err);
    }
  }

  return {
    deliverActivity,
    queueDelivery,
    resolveActorInbox,
    deliverToFollowers,
    sendFollow,
    sendUndoFollow,
    sendAccept,
    federateActorUpdate,
  };
}
