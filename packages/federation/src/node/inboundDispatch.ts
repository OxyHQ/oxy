/**
 * Inbound ActivityPub dispatch + the follow-protocol handlers.
 *
 * The engine owns the DISPATCHER (validate the untrusted activity, switch on its
 * type) and the FOLLOW-PROTOCOL verbs — Follow / Accept / Undo(Follow) / Reject —
 * because those are identical across every Oxy app: they bridge a federated follow
 * edge into the Oxy graph (via the identity adapter), record the AP-side follow
 * row (via the store adapter), and send the Accept back (via the delivery
 * service). Every CONTENT verb (Create / Announce / Like / Delete / Update, and a
 * non-follow Undo) is handed to the app-registered
 * {@link InboundDispatcherConfig.onContentActivity} callback, where the app's own
 * post/engagement handlers live. The consent gate + notification side effects are
 * injected so the engine holds no app knowledge.
 *
 * Extracted behaviour-identically from Mention's former `InboxProcessingService`
 * dispatcher + `handleIncomingFollow` / `handleUndo(Follow)` / `handleAccept` /
 * `handleReject`.
 */

import { normalizeActorUsername } from '../urls';

/**
 * Thrown when a federated follow is about to be bridged but the FOLLOWER actor
 * has not yet resolved to an Oxy user (`oxyUserId` missing) — e.g. Oxy was
 * unreachable when the actor was fetched. A federated follow MUST become a real
 * Oxy edge, never a ghost, so the whole inbound activity is DEFERRED rather than
 * bridged half-way:
 *
 *  - in the BullMQ inbox worker, throwing fails the job, which retries with
 *    bounded exponential backoff; a later attempt (Oxy reachable) resolves the
 *    actor and bridges the follow. A permanently-unresolvable actor exhausts the
 *    attempts and the activity is dropped — never a ghost edge.
 *  - in the inline (no-Redis) fallback, it surfaces as a 500 from the inbox
 *    endpoint, so the remote re-delivers per ActivityPub.
 */
export class ActorResolutionPendingError extends Error {
  /** The remote actor URI whose Oxy resolution is still pending. */
  readonly actorUri: string;

  constructor(actorUri: string, context?: string) {
    super(
      `Actor ${actorUri} is not yet resolved to an Oxy user${context ? ` (${context})` : ''}; deferring inbound activity`,
    );
    this.name = 'ActorResolutionPendingError';
    this.actorUri = actorUri;
  }
}

/** Minimal logging sink the inbound dispatcher writes to. */
export interface InboundDispatcherLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string, detail?: unknown): void;
}

/**
 * The verdict of validating an untrusted inbound activity: its primary type, or a
 * compact failure summary. The app owns the validation (its zod schemas); the
 * engine owns the drop-with-warn behaviour so every app logs identically.
 */
export type InboundActivityValidation =
  | { ok: true; type: string }
  | { ok: false; summary: string };

/** The Oxy-user fields the engine reads off a resolved local user (Follow target). */
export interface InboundLocalUser {
  _id?: string | null;
  id?: string | null;
}

/** The actor↔Oxy-user identity bridge the follow verbs use. */
export interface InboundIdentity {
  /** Resolve a local username to its Oxy user (the Follow target). Null when unknown. */
  resolveUserByUsername(username: string): Promise<InboundLocalUser | null>;
  /** Create the Oxy follow edge (`POST /federation/follow`). Throws on transport failure (retry). */
  bridgeFollow(followerOxyUserId: string, localUserId: string): Promise<void>;
  /** Remove the Oxy follow edge. Throws on transport failure (retry). */
  bridgeUnfollow(followerOxyUserId: string, localUserId: string): Promise<void>;
}

/** The fediverse-sharing consent gate for the inbound Follow. */
export interface InboundConsent {
  /** Sync read off an already-resolved user object (absent flag ⇒ enabled). */
  isSharingEnabledFromUser(user: InboundLocalUser): boolean;
}

/** The actor resolver subset the inbound follow uses (resolve + require an Oxy id). */
export interface InboundActorResolver {
  /** Resolve/mint the follower actor and its Oxy user (`getOrFetchActor`). */
  getOrFetchActor(actorUri: string): Promise<{ oxyUserId?: string | null } | null>;
}

/** Bring-your-own-store: the AP follow records + actor cache reads the follow verbs need. */
export interface InboundFollowStore {
  /** `handleIncomingFollow`: upsert the accepted inbound follow row. */
  upsertInboundAccepted(localUserId: string, remoteActorUri: string, activityId: string): Promise<void>;
  /** `handleUndo(Follow)`: the inbound follow row (scoped by localUserId when known). */
  findInboundFollow(remoteActorUri: string, localUserId?: string): Promise<{ _id: unknown; localUserId: string } | null>;
  /** `handleUndo(Follow)`: delete a follow row by id. */
  deleteFollowById(id: unknown): Promise<void>;
  /** `handleUndo(Follow)`: the follower actor's cached Oxy user id (for `bridgeUnfollow`). */
  findActorOxyUserId(uri: string): Promise<string | null | undefined>;
  /** `handleAccept`: mark the matching outbound-pending follow accepted BY its activity id. Returns whether a row changed. */
  markOutboundAcceptedByActivityId(remoteActorUri: string, activityId: string): Promise<boolean>;
  /** `handleAccept`: mark ANY outbound-pending follow for this actor accepted. Returns whether a row changed. */
  markOutboundAcceptedAnyPending(remoteActorUri: string): Promise<boolean>;
  /** `handleReject`: mark the matching outbound-pending follow rejected. */
  markOutboundRejected(remoteActorUri: string, activityId?: string): Promise<void>;
}

/** The delivery subset the inbound Follow uses (send the Accept back). */
export interface InboundDelivery {
  sendAccept(
    localOxyUserId: string,
    localUsername: string,
    followActivityId: string,
    remoteActorUri: string,
  ): Promise<void>;
}

/** Adapters + hooks an {@link InboundDispatcher} is built from. */
export interface InboundDispatcherConfig {
  /**
   * The app's per-instance domain policy (`DomainPolicy.isBlockedDomain`) — our own
   * ActivityPub domains, the Oxy identity apex, and every explicitly suspended
   * instance. Applied to the host of the VERIFIED origin actor before an inbound
   * activity is dispatched, so a suspended instance can create nothing here.
   *
   * REQUIRED, deliberately: an app that forgets to wire it would silently federate
   * with every instance it has ever cached, which is exactly the failure this gate
   * exists to prevent. A missing policy must be a compile error, not a quiet hole.
   */
  isBlockedDomain(host: string): boolean;
  /** Validate + extract the primary type of an untrusted inbound activity (app's zod schemas). */
  validateActivity(activity: Record<string, unknown>): InboundActivityValidation;
  /** The actor↔Oxy-user identity bridge. */
  identity: InboundIdentity;
  /** The fediverse-sharing consent gate. */
  consent: InboundConsent;
  /** The actor resolver (resolve the follower actor). */
  actorResolver: InboundActorResolver;
  /** The AP follow-record store. */
  follows: InboundFollowStore;
  /** The delivery service (send the Accept). */
  delivery: InboundDelivery;
  /**
   * Best-effort: notify the local user of a newly-accepted inbound follow.
   * NEVER throws (it handles its own errors); a failure must not fail (and thus
   * retry) the inbox activity. Absent ⇒ no notification.
   */
  onInboundFollowAccepted?(localUserId: string, followerOxyUserId: string, actorUri: string): Promise<void>;
  /**
   * Best-effort: backfill the newly-followed remote actor's recent posts after an
   * outbound Follow was Accepted. NEVER throws. Absent ⇒ no backfill.
   */
  onOutboundFollowAccepted?(actorUri: string): Promise<void>;
  /**
   * Handle a CONTENT activity the engine does not own — Create / Announce / Like /
   * Delete / Update, and a non-follow Undo. The app's post/engagement handlers.
   */
  onContentActivity(activity: Record<string, unknown>, verifiedActorUri: string): Promise<void>;
  /** Diagnostics sink. */
  logger: InboundDispatcherLogger;
}

/** The inbound-activity dispatcher. */
export interface InboundDispatcher {
  /** Process one already-actor-verified inbound activity. */
  processInboxActivity(activity: Record<string, unknown>, verifiedActorUri: string): Promise<void>;
}

/**
 * The lowercased host of an actor URI, or null when it is not a parseable absolute
 * URL. Callers treat null as blocked: an origin whose host cannot be determined
 * cannot be checked against the domain policy, so it fails closed.
 */
function actorUriHost(actorUri: string): string | null {
  try {
    return new URL(actorUri).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Read the `object`'s referenced actor/target uri (a string, or an embedded `{ id }`). */
function objectTargetUri(object: unknown): string | undefined {
  if (typeof object === 'string') return object;
  if (object && typeof object === 'object') {
    const id = (object as { id?: unknown }).id;
    if (typeof id === 'string') return id;
  }
  return undefined;
}

/** Build the inbound-activity dispatcher from an app's adapters + content handlers. */
export function createInboundDispatcher(config: InboundDispatcherConfig): InboundDispatcher {
  const { logger } = config;

  async function handleIncomingFollow(activity: Record<string, unknown>, actorUri: string): Promise<void> {
    const targetActorUri = objectTargetUri(activity.object);
    if (!targetActorUri) return;

    // Extract username from our actor URL
    const match = targetActorUri.match(/\/ap\/users\/([^/]+)$/);
    if (!match) return;
    const username = normalizeActorUsername(match[1]);

    // Resolve the Oxy user to get a real user ID
    const user = await config.identity.resolveUserByUsername(username);
    if (!user) {
      logger.warn(`Incoming follow for unknown user ${username} from ${actorUri}`);
      return;
    }
    const localUserId = String(user._id || user.id);

    // The target user may have turned fediverse sharing off — drop the Follow
    // silently (no bridge, no Accept, no Reject). A Reject is unverifiable
    // against a 404'd actor and would reveal the account exists, so this must
    // look identical to a Follow sent to an unknown user. Gated here, BEFORE
    // the follower actor is fetched/resolved, so an OFF user never triggers any
    // of the bridge/Accept/notification side effects below.
    if (!config.consent.isSharingEnabledFromUser(user)) {
      logger.debug(`[Federation] inbound follow for ${username} dropped — sharing off`);
      return;
    }

    // Resolve the follower actor and REQUIRE its Oxy user id: a fediverse
    // follower must become a real Oxy edge, never a ghost. When the actor is
    // missing or not yet resolved to an Oxy user (Oxy was unreachable when it was
    // fetched), throw `ActorResolutionPendingError` so the BullMQ inbox job
    // retries with backoff and bridges the follow on a later attempt.
    const actor = await config.actorResolver.getOrFetchActor(actorUri);
    const followerOxyUserId = actor?.oxyUserId;
    if (!followerOxyUserId) {
      throw new ActorResolutionPendingError(actorUri, `Follow ${String(activity.id)}`);
    }

    // A self-follow (the follower resolves to the same local user) is meaningless
    // in the Oxy graph — skip before touching any state or delivering an Accept.
    if (followerOxyUserId === localUserId) {
      logger.debug(`[Federation] ignoring self-follow from ${actorUri} to ${username}`);
      return;
    }

    // Create the Oxy follow edge BEFORE sending Accept so a retry never spams
    // Accepts: the bridge is idempotent (safe to re-run), but an Accept delivered
    // before the edge was committed could be re-sent on every retry. On failure
    // the bridge throws, failing the job so the whole sequence retries.
    await config.identity.bridgeFollow(followerOxyUserId, localUserId);

    await config.follows.upsertInboundAccepted(localUserId, actorUri, String(activity.id));

    // Send Accept back so the remote server knows the follow succeeded
    await config.delivery.sendAccept(localUserId, username, String(activity.id), actorUri);

    // Fail-soft: the Oxy edge is already committed, so a notification failure must
    // never fail (and thus retry) the follow.
    if (config.onInboundFollowAccepted) {
      await config.onInboundFollowAccepted(localUserId, followerOxyUserId, actorUri);
    }

    logger.info(`Accepted follow from ${actorUri} to ${username}`);
  }

  async function handleUndoFollow(object: Record<string, unknown>, actorUri: string): Promise<void> {
    const targetActorUri = objectTargetUri(object.object);
    const match = targetActorUri?.match(/\/ap\/users\/([^/]+)$/);
    let localUserId: string | undefined;
    if (match) {
      const user = await config.identity.resolveUserByUsername(normalizeActorUsername(match[1]));
      if (user) localUserId = String(user._id || user.id);
    }

    // Idempotency: locate the follow row FIRST. Absent → this Undo was already
    // processed (a redelivery), so there is nothing to tear down — return.
    const follow = await config.follows.findInboundFollow(actorUri, localUserId);
    if (!follow) {
      logger.debug(`Undo follow from ${actorUri}: no matching row (already processed)`);
      return;
    }

    // Remove the Oxy follow edge BEFORE deleting the local row, so a transient
    // bridge failure retries with the row still present. The edge can only exist
    // when the follower actor resolved to an Oxy user; without an `oxyUserId` no
    // edge was ever created, so there is nothing to remove. THROW on transient
    // bridge failure (job retry); the bridge is idempotent.
    const followerOxyUserId = await config.follows.findActorOxyUserId(actorUri);
    if (followerOxyUserId) {
      await config.identity.bridgeUnfollow(followerOxyUserId, follow.localUserId);
    }

    await config.follows.deleteFollowById(follow._id);
    logger.debug(`Undo follow from ${actorUri}`);
  }

  async function handleUndo(activity: Record<string, unknown>, actorUri: string): Promise<void> {
    const object = activity.object;
    if (!object) return;

    const objectType = typeof object === 'string' ? null : (object as { type?: unknown }).type;
    if (objectType === 'Follow') {
      await handleUndoFollow(object as Record<string, unknown>, actorUri);
    } else {
      // Undo(Like) / Undo(Announce) — content teardown. Hand the WHOLE Undo
      // activity to the app (it re-inspects the embedded object type).
      await config.onContentActivity(activity, actorUri);
    }
  }

  async function handleAccept(activity: Record<string, unknown>, actorUri: string): Promise<void> {
    const object = activity.object;
    if (!object) return;

    let updated = false;

    if (typeof object === 'string') {
      // Remote sent Accept with a string reference (the Follow activity ID).
      // Try matching by activityId first, fall back to any pending follow.
      updated = await config.follows.markOutboundAcceptedByActivityId(actorUri, object);
      if (!updated) {
        updated = await config.follows.markOutboundAcceptedAnyPending(actorUri);
      }
    } else if ((object as { type?: unknown }).type === 'Follow') {
      const followActivityId = (object as { id?: unknown }).id;
      updated = typeof followActivityId === 'string' && followActivityId.length > 0
        ? await config.follows.markOutboundAcceptedByActivityId(actorUri, followActivityId)
        : await config.follows.markOutboundAcceptedAnyPending(actorUri);
    }

    if (updated) {
      logger.debug(`Follow accepted by ${actorUri}`);
      // Fire-and-forget: backfill the newly followed actor's recent posts.
      if (config.onOutboundFollowAccepted) {
        await config.onOutboundFollowAccepted(actorUri);
      }
    }
  }

  async function handleReject(activity: Record<string, unknown>, actorUri: string): Promise<void> {
    const object = activity.object;
    if (!object) return;

    const objectType = typeof object === 'string' ? null : (object as { type?: unknown }).type;
    if (objectType === 'Follow') {
      const followActivityId = typeof object === 'object' ? (object as { id?: unknown }).id : undefined;
      await config.follows.markOutboundRejected(
        actorUri,
        typeof followActivityId === 'string' ? followActivityId : undefined,
      );
      logger.debug(`Follow rejected by ${actorUri}`);
    }
  }

  async function processInboxActivity(activity: Record<string, unknown>, verifiedActorUri: string): Promise<void> {
    // Instance domain policy, FIRST — before the payload is even parsed.
    //
    // This is the single chokepoint for inbound federation: every transport (the
    // inbox route's inline path, the BullMQ inbox worker replaying a queued job,
    // and any direct connector call) converges here, and every verb — Follow,
    // Accept, Undo, Reject, and the app's content verbs — is dispatched below it.
    // So one check here suspends an instance completely: no posts, no actors, no
    // follows, no boosts, no notifications.
    //
    // It is keyed on `verifiedActorUri`, the origin the HTTP signature actually
    // proved, which is also the identity every handler downstream trusts — so
    // there is no second, weaker identity a hostile payload could be routed under.
    const originHost = actorUriHost(verifiedActorUri);
    if (originHost === null || config.isBlockedDomain(originHost)) {
      logger.warn(
        `[Federation] dropping inbound activity from blocked origin ${verifiedActorUri} (host=${originHost ?? 'unparseable'})`,
      );
      return;
    }

    // Inbound JSON arrives from arbitrary, UNTRUSTED remote servers. Validate the
    // whole activity BEFORE any handler reads it. The validation never throws; a
    // malformed or hostile payload is rejected cleanly here.
    const validation = config.validateActivity(activity);
    if (!validation.ok) {
      const rawType =
        typeof activity?.type === 'string'
          ? activity.type
          : Array.isArray(activity?.type)
            ? activity.type.join(',')
            : 'unknown';
      const rawId = typeof activity?.id === 'string' ? activity.id : 'unknown';
      logger.warn(
        `[Federation] dropping invalid inbound activity from ${verifiedActorUri} (type=${rawType}, id=${rawId}): ${validation.summary}`,
      );
      return;
    }

    switch (validation.type) {
      case 'Follow':
        await handleIncomingFollow(activity, verifiedActorUri);
        break;
      case 'Undo':
        await handleUndo(activity, verifiedActorUri);
        break;
      case 'Accept':
        await handleAccept(activity, verifiedActorUri);
        break;
      case 'Reject':
        await handleReject(activity, verifiedActorUri);
        break;
      // Content verbs — the app owns these (posts, engagement, actor profile edits).
      case 'Create':
      case 'Delete':
      case 'Like':
      case 'Announce':
      case 'Update':
        await config.onContentActivity(activity, verifiedActorUri);
        break;
      default:
        logger.debug(`Unhandled activity type: ${validation.type}`);
    }
  }

  return { processInboxActivity };
}
