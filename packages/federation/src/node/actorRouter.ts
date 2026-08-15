/**
 * The ActivityPub actor + inbox + follow-graph router.
 *
 * Serves the engine-owned half of the `/ap` namespace:
 *  - `GET /users/:username` — the local `Person` actor (and the special `instance`
 *    Application actor used for signed fetches),
 *  - `POST /users/:username/inbox` + `POST /inbox` — inbound delivery, with HTTP
 *    signature verification (Phase 2, `trustForwardedHost`) and actor-match, then
 *    202 + async dispatch to the injected inbound dispatcher,
 *  - `GET /users/:username/followers` + `/following` — the OXY follow graph
 *    (local + bridged federated edges) as paginated `OrderedCollection`s.
 *
 * The CONTENT routes (`outbox`, `featured`, per-post dereference) stay in the app,
 * mounted on the SAME `/ap/users/:username/*` prefix the actor advertises.
 *
 * Extracted behaviour-identically from Mention's `ap.routes.ts`. Everything
 * app-specific — the actor's Oxy profile, the banner, the fediverse-sharing gate,
 * the public-key lookup, the inbox enqueue transport, the follow-graph page fetch
 * — is injected.
 */

import { Router, type Request, type Response } from 'express';
import type { AccountKind } from '@oxyhq/contracts';
import type { User } from '@oxyhq/core';
import { AP_CONTEXT } from '../apContext';
import { verifyHttpSignature } from '../httpSignature';
import type { UrlBuilders } from '../urls';
import { INSTANCE_ACTOR_USERNAME, normalizeActorUsername } from '../urls';
import type { LocalActorBuilder } from '../actorObject';

/** Page size for the paginated followers/following collections (mirrors the outbox). */
const FOLLOW_PAGE_SIZE = 20;

/** The resolved-user fields the actor + collection routes read. */
export interface ActorRouteUser {
  _id?: string | null;
  id?: string | null;
  name?: { displayName?: string | null } | null;
  bio?: string | null;
  avatar?: string | null;
  createdAt?: string | null;
  /** Account-graph classification — decides the actor `type`. */
  kind?: AccountKind | null;
  _count?: { followers?: number; following?: number } | null;
}

/** The tri-state consent read for a username with no already-resolved user object. */
export type ActorSharingState = 'enabled' | 'disabled' | 'unknown-user' | 'unavailable';

/** An inbound request may carry the raw (pre-parse) body used for digest verification. */
interface InboxRequest extends Request {
  rawBody?: unknown;
}

/** Minimal logging sink the actor router writes to. */
export interface ActorRouterLogger {
  debug(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
}

/** A page of a user's follow graph (from the authoritative Oxy graph). */
export interface FollowPage {
  members: User[];
  total: number;
  hasMore: boolean;
}

/** Adapters + config a {@link createActorRouter} is built from. */
export interface ActorRouterConfig {
  /** The app's federation domain (the human-facing `url` host + non-AP redirect target). */
  domain: string;
  /** Whether federation is enabled (all routes 404 when off). */
  federationEnabled: boolean;
  /** The AP content type (`application/activity+json`). */
  apContentType: string;
  /** Per-instance URL builders. */
  urls: UrlBuilders;
  /** True when the request's Accept header asks for ActivityPub JSON. */
  wantsActivityPub(accept: string | string[] | undefined): boolean;
  /** Fetch the public keyId + PEM for a username (`instance` for the server actor). */
  getPublicKey(username: string): Promise<{ keyId: string; publicKeyPem: string }>;
  /** Resolve a username to its Oxy user (null when unknown). */
  resolveUser(username: string): Promise<ActorRouteUser | null>;
  /** The fediverse-sharing consent gate. */
  consent: {
    isSharingEnabledFromUser(user: ActorRouteUser): boolean;
    getSharingStateByUsername(username: string): Promise<ActorSharingState>;
  };
  /** The single local-actor builder (shared with the `Update(Person)` broadcast). */
  buildLocalActorObject: LocalActorBuilder;
  /** The app-owned profile banner (Mention: `UserSettings.profileHeaderImage`). */
  getBanner(oxyUserId: string): Promise<string | null>;
  /** Inbound-delivery adapters. */
  inbound: {
    /** Resolve a `keyId` to its public key PEM + owning actor uri (HTTP-sig verify). */
    fetchPublicKey(keyId: string): Promise<{ publicKeyPem: string; actorUri: string } | null>;
    /** Whether to trust `X-Forwarded-Host` when reconstructing the signed host line. */
    trustForwardedHost: boolean;
    /** Enqueue a verified inbound activity for async processing (false ⇒ process inline). */
    enqueueInboxActivity(job: { activity: Record<string, unknown>; verifiedActorUri: string }): Promise<boolean>;
    /** The inbound dispatcher (the inline-fallback + post-enqueue processor). */
    processInboxActivity(activity: Record<string, unknown>, verifiedActorUri: string): Promise<void>;
  };
  /** Fetch one page of a user's Oxy follow graph (followers OR following). */
  fetchFollowPage(
    userId: string,
    direction: 'followers' | 'following',
    offset: number,
    limit: number,
  ): Promise<FollowPage>;
  /** Diagnostics sink. */
  logger: ActorRouterLogger;
}

/** Extract the `:username` param safely as a string. */
function getUsername(req: Request): string {
  const val = req.params.username;
  const raw = typeof val === 'string' ? val : Array.isArray(val) ? val[0] : String(val);
  return normalizeActorUsername(raw);
}

/**
 * Map a follow-graph member (an Oxy `User`) to its ActivityPub actor URI:
 *  - a LOCAL Oxy/Mention user → our minted actor URL,
 *  - a FEDERATED user → the remote actor URI on `federation.actorUri`.
 * Returns null when unmappable (skip — never emit a raw oxyUserId as an actor id).
 */
function memberActorUri(user: User, urls: UrlBuilders): string | null {
  const isFederated = user.type === 'federated' || user.isFederated === true;
  if (isFederated) {
    const uri = user.federation?.actorUri;
    return typeof uri === 'string' && uri.length > 0 ? uri : null;
  }
  const { username } = user;
  return typeof username === 'string' && username.length > 0 ? urls.actor(username) : null;
}

/** Parse a non-negative page offset from the request query (missing/invalid ⇒ 0). */
function parseFollowOffset(raw: unknown): number {
  const value = typeof raw === 'string' ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Build the actor + inbox + follow-graph router for an app's domain. */
export function createActorRouter(config: ActorRouterConfig): Router {
  const router = Router();
  const { urls, domain, apContentType, logger } = config;

  function wantsActivityPub(req: Request): boolean {
    return config.wantsActivityPub(req.headers.accept);
  }

  /** Common inbox handler with HTTP signature verification. */
  async function handleInbox(req: InboxRequest, res: Response): Promise<Response> {
    try {
      // Verify HTTP signature (use originalUrl to avoid proxy path mangling).
      const { verified, actorUri, reason: signatureError } = await verifyHttpSignature(
        {
          method: req.method,
          path: req.originalUrl || req.path,
          headers: req.headers as Record<string, string | string[] | undefined>,
          body: req.rawBody ?? req.body,
        },
        (keyId) => config.inbound.fetchPublicKey(keyId),
        {
          trustForwardedHost: config.inbound.trustForwardedHost,
          onDebug: (message, detail) => logger.debug(message, detail),
        },
      );

      if (!verified || !actorUri) {
        logger.debug('Inbox: HTTP signature verification failed', { reason: signatureError });
        return res.status(401).json({ error: 'Invalid signature' });
      }

      const activity = req.body;
      if (!activity || !activity.type) {
        return res.status(400).json({ error: 'Invalid activity' });
      }

      // Verify the actor in the activity matches the signature.
      const activityActor = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;
      if (activityActor !== actorUri) {
        logger.debug(`Inbox: Actor mismatch. Signed: ${actorUri}, Activity: ${activityActor}`);
        return res.status(403).json({ error: 'Actor mismatch' });
      }

      // Process asynchronously — return 202 Accepted immediately. Durable path:
      // enqueue onto BullMQ keyed by the activity id (dedupe). When the queue is
      // unavailable (Redis not configured) OR the activity has no stable id to
      // dedupe on, fall back to inline fire-and-forget processing so the activity
      // is never dropped.
      let enqueued = false;
      try {
        enqueued = await config.inbound.enqueueInboxActivity({ activity, verifiedActorUri: actorUri });
      } catch (err) {
        logger.error('Failed to enqueue inbox activity — processing inline:', err);
        enqueued = false;
      }

      if (!enqueued) {
        config.inbound.processInboxActivity(activity, actorUri).catch((err) => {
          logger.error('Error processing inbox activity:', err);
        });
      }

      return res.status(202).json({ status: 'accepted' });
    } catch (err) {
      logger.error('Inbox error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * Serve a user's followers OR following as a paginated `OrderedCollection` over
   * the authoritative Oxy follow graph (local + bridged federated edges).
   */
  async function serveFollowCollection(
    req: Request,
    res: Response,
    direction: 'followers' | 'following',
    collectionUrl: (username: string) => string,
  ): Promise<Response> {
    if (!config.federationEnabled) return res.status(404).json({ error: 'Federation disabled' });

    const username = getUsername(req);
    const page = req.query.page === 'true';

    try {
      const user = await config.resolveUser(username);
      if (!user) return res.status(404).json({ error: 'User not found' });

      if (!config.consent.isSharingEnabledFromUser(user)) {
        return res.status(404).json({ error: 'User not found' });
      }

      const userId = String(user._id || user.id);

      const rawCount: unknown = direction === 'followers' ? user._count?.followers : user._count?.following;
      const profileTotal = typeof rawCount === 'number' ? rawCount : undefined;

      if (!page) {
        // Prefer the profile `_count`; only when absent (the rare search fallback)
        // fetch the authoritative total from a minimal graph list call. Fail-soft
        // to 0 — never 500 the summary.
        let totalItems = profileTotal ?? 0;
        if (profileTotal === undefined) {
          try {
            totalItems = (await config.fetchFollowPage(userId, direction, 0, 1)).total;
          } catch (err) {
            logger.warn('[Federation] follow-collection summary total lookup failed', {
              username, direction, error: err,
            });
          }
        }

        res.set('Content-Type', apContentType);
        return res.json({
          '@context': AP_CONTEXT,
          id: collectionUrl(username),
          type: 'OrderedCollection',
          totalItems,
          first: `${collectionUrl(username)}?page=true`,
        });
      }

      const offset = parseFollowOffset(req.query.offset);

      let members: User[] = [];
      let total = profileTotal ?? 0;
      let hasMore = false;
      try {
        const pageResult = await config.fetchFollowPage(userId, direction, offset, FOLLOW_PAGE_SIZE);
        members = pageResult.members;
        total = pageResult.total;
        hasMore = pageResult.hasMore;
      } catch (err) {
        // Fail-soft: never 500 the whole collection on an Oxy graph hiccup — serve
        // an empty page against the best-known total rather than crashing.
        logger.warn('[Federation] follow-collection Oxy graph list failed, serving empty page', {
          username, direction, offset, error: err,
        });
      }

      const orderedItems = members
        .map((member) => memberActorUri(member, urls))
        .filter((uri): uri is string => uri !== null);

      const pageId = offset > 0
        ? `${collectionUrl(username)}?page=true&offset=${offset}`
        : `${collectionUrl(username)}?page=true`;

      const pageResponse: Record<string, unknown> = {
        '@context': AP_CONTEXT,
        id: pageId,
        type: 'OrderedCollectionPage',
        partOf: collectionUrl(username),
        totalItems: total,
        orderedItems,
      };

      if (hasMore) {
        pageResponse.next = `${collectionUrl(username)}?page=true&offset=${offset + FOLLOW_PAGE_SIZE}`;
      }

      res.set('Content-Type', apContentType);
      return res.json(pageResponse);
    } catch (err) {
      logger.error('Follow collection endpoint error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  // GET /ap/users/:username — ActivityPub Actor endpoint
  router.get('/users/:username', async (req: Request, res: Response) => {
    if (!config.federationEnabled) return res.status(404).json({ error: 'Federation disabled' });

    if (!wantsActivityPub(req)) {
      // Redirect to the frontend profile if not an AP request.
      return res.redirect(`https://${domain}/@${getUsername(req)}`);
    }

    const username = getUsername(req);

    try {
      // Instance actor: a special server-level actor used for signed fetches. It
      // has no Oxy user — serve it directly from the key material. The WebFinger
      // router answers for the SAME username, and its `self` href is built from
      // the same `urls.actor(INSTANCE_ACTOR_USERNAME)` call as the `id` below,
      // because Mastodon rejects a signed fetch when the two disagree.
      if (username === INSTANCE_ACTOR_USERNAME) {
        const publicKey = await config.getPublicKey(INSTANCE_ACTOR_USERNAME);
        const actorObject = {
          '@context': AP_CONTEXT,
          id: urls.actor(INSTANCE_ACTOR_USERNAME),
          type: 'Application',
          preferredUsername: INSTANCE_ACTOR_USERNAME,
          name: domain,
          summary: '',
          url: `https://${domain}`,
          inbox: urls.inbox(INSTANCE_ACTOR_USERNAME),
          outbox: urls.outbox(INSTANCE_ACTOR_USERNAME),
          endpoints: { sharedInbox: urls.sharedInbox() },
          manuallyApprovesFollowers: false,
          discoverable: false,
          publicKey: {
            id: publicKey.keyId,
            owner: urls.actor(INSTANCE_ACTOR_USERNAME),
            publicKeyPem: publicKey.publicKeyPem,
          },
        };
        res.set('Content-Type', apContentType);
        res.set('Cache-Control', 'max-age=1800');
        return res.json(actorObject);
      }

      const user = await config.resolveUser(username);
      if (!user) return res.status(404).json({ error: 'User not found' });

      // Sharing OFF must be indistinguishable from a nonexistent user — same 404
      // body, no separate error code. Derived from the already-resolved user.
      if (!config.consent.isSharingEnabledFromUser(user)) {
        return res.status(404).json({ error: 'User not found' });
      }

      const publicKey = await config.getPublicKey(username);

      // The profile banner lives in the app's own per-user settings (not the Oxy
      // user DTO), keyed by the resolved Oxy user id. Advertise it as the AP
      // `image` (Mastodon header). Absent settings / banner cleanly omits it.
      const userId = user._id || user.id;
      const profileHeaderImage = userId ? await config.getBanner(String(userId)) : null;

      // Canonical display name is owned by the Oxy API (`name.displayName`); fall
      // back to the username only if the API omitted it, so `name` is never empty.
      const displayName = user.name?.displayName || username;

      // ONE actor builder — shared with the outbound `Update(Person)` broadcast — so
      // a fetched actor and a pushed actor Update never drift. The route owns the
      // top-level JSON-LD `@context` (the builder omits it).
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

      res.set('Content-Type', apContentType);
      res.set('Cache-Control', 'max-age=1800');
      return res.json({ '@context': AP_CONTEXT, ...actorObject });
    } catch (err) {
      logger.error('Actor endpoint error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /ap/users/:username/inbox — User inbox
  router.post('/users/:username/inbox', async (req: Request, res: Response) => {
    if (!config.federationEnabled) return res.status(404).json({ error: 'Federation disabled' });

    // Sharing OFF (or a bogus `:username`) must be indistinguishable from a
    // nonexistent user — same 404 body. An Oxy OUTAGE ('unavailable') is
    // deliberately NOT 404'd: this is a POST delivery, and a 4xx makes the remote
    // server drop it permanently rather than retry, so availability wins over
    // gating freshness — the activity is processed and any consent decision is
    // re-checked downstream by the id-based (fail-open) gates.
    const username = getUsername(req);
    const sharingState = await config.consent.getSharingStateByUsername(username);
    if (sharingState === 'disabled' || sharingState === 'unknown-user') {
      return res.status(404).json({ error: 'User not found' });
    }

    return handleInbox(req, res);
  });

  // POST /ap/inbox — Shared inbox
  router.post('/inbox', async (req: Request, res: Response) => {
    if (!config.federationEnabled) return res.status(404).json({ error: 'Federation disabled' });
    return handleInbox(req, res);
  });

  // GET /ap/users/:username/followers — Followers collection (Oxy graph: local + federated).
  router.get('/users/:username/followers', (req: Request, res: Response) =>
    serveFollowCollection(req, res, 'followers', urls.followers),
  );

  // GET /ap/users/:username/following — Following collection (Oxy graph: local + federated).
  router.get('/users/:username/following', (req: Request, res: Response) =>
    serveFollowCollection(req, res, 'following', urls.following),
  );

  return router;
}
