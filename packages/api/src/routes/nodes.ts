/**
 * User-Node Routes (self-sovereign identity layer — F5a user nodes)
 *
 * Mounted at `/nodes`:
 *  - `GET    /nodes/me` (auth) — the caller's registered node + live status.
 *  - `DELETE /nodes/me` (auth) — revoke the caller's node registration.
 *
 * Bearer-authenticated (no app-local CSRF — bearer-write rule). The owner id is
 * always resolved server-side from the session (never from the body). Node
 * REGISTRATION is not here — a node is registered by publishing a signed
 * `type:'node'` record to `POST /identity/records`, which materializes the
 * operational cache via `nodeRegistry.service`. These routes only read and
 * revoke that cache; nothing here ever fetches a node (revocation is a local
 * cache write — the read-path invariant holds).
 */

import { Router, type Request, type Response } from 'express';
import { and, eq, ne } from 'drizzle-orm';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError, ErrorCodes, InternalServerError, NotFoundError, UnauthorizedError } from '../utils/error';
import { rateLimit } from '../middleware/rateLimiter';
import { hashedIpKey } from '../utils/ipKey';
import { getDb } from '../config/postgres';
import { userNodes } from '../db/schema/userNodes';
import {
  getUserNode,
  removeNode,
  provisionManagedVault,
  type UserNodeRecord,
} from '../services/nodeRegistry.service';
import { enqueueNodeIngest } from '../queue/nodeIngest.queue';

const router = Router();

/**
 * The keying half of a per-authenticated-user budget: the key generator and the
 * `skip` that pairs with it, built together so the two can never disagree about
 * what "no key" means.
 *
 * ## The account key only exists AFTER `authMiddleware`, so the limiter runs after it
 *
 * That ordering is the whole mechanism rather than a detail. All three limiters
 * below used to be mounted BEFORE `authMiddleware` on their routes, and Express
 * runs middleware in declaration order — so `req.user` was undefined every single
 * time a key was computed and the old `: ${scope}:ip:${hashedIpKey(req)}` arm was
 * not a fallback, it was the only branch that ever ran. The per-user budget each
 * of them advertises was unreachable: every caller behind one NAT egress shared
 * one 120/20/10-per-minute bucket, and a single flood took out everybody on it.
 *
 * No user IP leaked from that — `hashedIpKey` is the sanctioned transient path
 * (IPv6 bucketed to /56, HMAC'd under an `rl|` namespace, alive only as a Redis
 * key with the limiter's TTL) — so this was a dead budget, not the privacy breach
 * the same shape caused in `routes/store.ts`. It is fixed the same way regardless.
 *
 * ## Why there is no IP arm left at all, hashed or otherwise
 *
 * A request whose account did not resolve is SKIPPED rather than bucketed under a
 * shared key. If one of these limiters is ever reordered in front of
 * `authMiddleware` again, the degradation is then a visible "no per-user budget"
 * instead of silently collapsing every caller into one bucket again — the exact
 * failure above, which stayed invisible precisely because the IP arm made it look
 * like the limiter was still working.
 *
 * ## What covers the pre-auth lane, since these no longer do
 *
 * Every route using this keying is `authMiddleware`-gated, so an unauthenticated
 * request 401s before it reaches any node state. Two global middlewares in
 * `server.ts`, registered before any router, cover that lane; neither skips
 * `/nodes` (their skip lists are `/files/upload` and the service-to-service
 * paths), and both key through `hashedIpKey`:
 *
 *   - `rateLimiter` (`rl:general:`, 1000/15min in production) — the per-IP ceiling
 *     every unauthenticated request on this API is subject to.
 *   - `bruteForceProtection` (`slowDown`, +500ms after 100/15min) — a progressive
 *     delay on the same key.
 *
 * The one route in this file that is unauthenticated BY DESIGN —
 * `POST /nodes/ingest/notify/:userId` — is unaffected: it keeps its own
 * `nodeIngestNotifyLimiter` mounted pre-auth, because it has no principal to key
 * on and `hashedIpKey` is all there is.
 */
function userScopedKeying(scope: string) {
  const keyGenerator = (req: AuthRequest): string => {
    const userId = req.user?.id;
    return userId ? `${scope}:${userId}` : '';
  };
  return {
    keyGenerator,
    /**
     * The NEGATION of "the key exists", never a policy decision — anything that
     * decides whether a caller deserves a limit belongs in the route. It CALLS
     * the generator instead of restating its test, so a change to what counts as
     * a principal cannot leave the two disagreeing and a request bucketed under
     * the empty string.
     */
    skip: (req: AuthRequest): boolean => keyGenerator(req) === '',
  };
}

const nodeReadLimiter = rateLimit({
  prefix: 'rl:nodes:read:',
  windowMs: 60 * 1000,
  max: 120,
  message: 'Too many node status requests. Please slow down.',
  ...userScopedKeying('nodes:read'),
});

const nodeAdminLimiter = rateLimit({
  prefix: 'rl:nodes:admin:',
  windowMs: 60 * 1000,
  max: 20,
  message: 'Too many node management requests. Please slow down.',
  ...userScopedKeying('nodes:admin'),
});

/**
 * Managed-vault provisioning limiter (F5c). Provisioning custodial-signs a chain
 * record + materializes a node, so it is deliberately rarer than the admin path —
 * a low per-user ceiling is plenty for the "Create your vault" action and blunts
 * any attempt to spam chain writes.
 */
const nodeManagedLimiter = rateLimit({
  prefix: 'rl:nodes:managed:',
  windowMs: 60 * 1000,
  max: 10,
  message: 'Too many managed vault requests. Please slow down.',
  ...userScopedKeying('nodes:managed'),
});

/**
 * Ingest-notify limiter (F5b). The endpoint is an unauthenticated HINT, so it is
 * keyed by IP and held to a HARD ceiling — a notify only triggers a re-pull of
 * the named user's OWN node, which the worker then fully re-verifies, but the
 * enqueue itself must be cheap to throttle. Per-user dedup in the queue prevents
 * a flood from one target stacking work.
 */
const nodeIngestNotifyLimiter = rateLimit({
  prefix: 'rl:nodes:ingest:',
  windowMs: 60 * 1000,
  max: 30,
  message: 'Too many ingest notifications. Please slow down.',
  keyGenerator: (req: Request): string => `nodes:ingest:ip:${hashedIpKey(req)}`,
});

/** Public projection of a node row. */
function serializeNode(node: UserNodeRecord): Record<string, unknown> {
  return {
    nodeDid: node.nodeDid,
    endpoint: node.endpoint,
    nodePublicKey: node.nodePublicKey,
    mode: node.mode,
    managed: node.managed,
    controller: node.controller,
    status: node.status,
    lastSeenAt: node.lastSeenAt,
    lastProbeAt: node.lastProbeAt,
    lastError: node.lastError,
    cursor: node.cursor,
    lastSyncedAt: node.lastSyncedAt,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
}

/** GET /nodes/me — the caller's registered node (or `{ node: null }`). */
router.get(
  '/me',
  authMiddleware,
  nodeReadLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?._id?.toString();
    if (!userId) {
      throw new UnauthorizedError('Authentication required');
    }

    const node = await getUserNode(userId);
    res.json({ node: node ? serializeNode(node) : null });
  }),
);

/** DELETE /nodes/me — revoke the caller's node registration. */
router.delete(
  '/me',
  authMiddleware,
  nodeAdminLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?._id?.toString();
    if (!userId) {
      throw new UnauthorizedError('Authentication required');
    }

    const revoked = await removeNode(userId);
    if (!revoked) {
      throw new NotFoundError('No active node registration to revoke');
    }

    res.json({ success: true });
  }),
);

/**
 * POST /nodes/managed — provision an Oxy-operated MANAGED vault for the caller
 * (F5c "Create your vault"). The owner id is resolved from the session ONLY (the
 * request body is never read), Oxy custodial-signs the node registration onto the
 * caller's chain, and the materialized node is returned. Idempotent: an existing
 * active managed vault is refreshed in place, not duplicated.
 *
 * A missing Oxy custodial key or unconfigured managed-node fleet is server config,
 * so it answers 503 (try later) — never a silent broken vault.
 */
router.post(
  '/managed',
  authMiddleware,
  nodeManagedLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?._id?.toString();
    if (!userId) {
      throw new UnauthorizedError('Authentication required');
    }

    const result = await provisionManagedVault(userId);
    if (!result.ok) {
      switch (result.reason) {
        case 'oxy_key_unconfigured':
        case 'managed_endpoint_unconfigured':
          throw new ApiError(503, 'Managed vaults are not available right now', ErrorCodes.SERVICE_UNAVAILABLE);
        case 'user_not_found':
          throw new NotFoundError('User not found');
        default:
          throw new InternalServerError('Failed to provision managed vault');
      }
    }

    res.status(201).json({ node: serializeNode(result.node) });
  }),
);

/**
 * POST /nodes/ingest/notify/:userId — a HINT (no authority) that a user's node
 * has new records. The target is resolved server-side from the path param ONLY;
 * the request body is never read or trusted. If the named user has a registered
 * (non-revoked) node, a background ingest is enqueued — deduped per user, then
 * fully re-verified by the worker (a notify can never inject data). Always
 * answers 202: it is a fire-and-forget hint, not a probe.
 *
 * Unauthenticated by design (it only re-pulls the user's OWN node and changes
 * nothing without cryptographic verification), but rate-limited hard by IP. The
 * read path is untouched — this only schedules background work.
 *
 * The `isValidObjectId` pre-filter is DELETED, not ported. It existed to keep a
 * non-ObjectId path param out of a Mongoose `CastError`; here `user_id` is
 * `text`, so an unknown or malformed id simply selects no row. Keeping it would
 * have been worse than useless: every account minted since the cutover carries a
 * uuid v7, which the 24-hex predicate rejects — the notify would have silently
 * enqueued nothing for exactly those accounts, with a 202 either way. Same trap
 * the chain-head route hit (`routes/__tests__/chainHead.test.ts`).
 */
router.post(
  '/ingest/notify/:userId',
  nodeIngestNotifyLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.params;
    const [node] = await getDb()
      .select({ userId: userNodes.userId })
      .from(userNodes)
      .where(and(eq(userNodes.userId, userId), ne(userNodes.status, 'revoked')))
      .limit(1);
    if (node) {
      enqueueNodeIngest(userId);
    }
    res.status(202).json({ accepted: true });
  }),
);

export default router;
