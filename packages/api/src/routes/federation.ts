import { Router, type Response } from 'express';
import { and, eq } from 'drizzle-orm';
import { serviceAuthMiddleware, type ServiceAuthRequest } from '../middleware/auth';
import { asyncHandler, sendSuccess } from '../utils/asyncHandler';
import { validate } from '../middleware/validate';
import { ForbiddenError, NotFoundError, ConflictError } from '../utils/error';
import { logger } from '../utils/logger';
import { getDb } from '../config/postgres';
import { applications } from '../db/schema/applications';
import { users } from '../db/schema/users';
import userCache from '../utils/userCache';
import credentialDomainCache from '../utils/credentialDomainCache';
import {
  getUserPublicKey,
  signWithKeyId,
} from '../services/federation.service';
import { userService } from '../services/user.service';
import {
  DEFAULT_PURGE_LIMIT,
  purgeBlockedDomain,
  UnpurgeableDomainError,
} from '../services/federation/blockedDomainPurge.service';
import {
  publicKeyParamsSchema,
  publicKeyQuerySchema,
  signRequestSchema,
  federationFollowSchema,
  federationActorGoneSchema,
  federationActorDeleteSchema,
  federationDomainPurgeSchema,
  type PublicKeyParams,
  type PublicKeyQuery,
  type SignRequestBody,
  type FederationFollowBody,
  type FederationActorGoneBody,
  type FederationActorDeleteBody,
  type FederationDomainPurgeBody,
} from '../schemas/federation.schemas';

const router = Router();

const REQUIRED_SCOPE = 'federation:write';

/**
 * Uncached loader for the federation domains a given Application may sign for.
 *
 * SECURITY BOUNDARY (see {@link credentialDomainCache}): there is no explicit
 * federation-domain field on the Application, so — mirroring the
 * approved-clients derivation — we take the hostnames of the Application's
 * `redirectUris` as the set of domains its credentials may operate on. Only
 * `active` applications qualify; a suspended/deleted/pending app yields an empty
 * set and every host check then fails closed (403).
 *
 * FAIL CLOSED: a missing app, non-active status, or unparseable redirectUris all
 * resolve to an empty list. On a DB error we throw — the cache's loader wrapper
 * logs and treats the throw as an empty allow-list (deny), never a default.
 *
 * The status filter is a WHERE clause rather than a post-read comparison, so the
 * non-active case and the missing case reach the same `!app` branch and cannot
 * drift apart. There is no id-shape precheck: `appId` arrives from the verified
 * service token, `applications.id` is a `text` column, and an id that names no
 * application matches no row — which is the deny this function already returns.
 */
async function loadAllowedDomains(appId: string): Promise<string[]> {
  const [app] = await getDb()
    .select({ redirectUris: applications.redirectUris })
    .from(applications)
    .where(and(eq(applications.id, appId), eq(applications.status, 'active')))
    .limit(1);
  if (!app) {
    return [];
  }

  const hosts = new Set<string>();
  for (const uri of app.redirectUris) {
    try {
      hosts.add(new URL(uri).hostname.toLowerCase());
    } catch {
      // A malformed redirect URI contributes no authorisation. `NOT NULL` on a
      // `text[]` constrains the array, not its elements, so a NULL element is
      // representable — `new URL(null)` throws here too and is denied the same
      // way, which is why the parse is the only filter.
    }
  }
  return Array.from(hosts);
}

/**
 * Resolve the set of federation hosts the requesting service credential may
 * operate on. Reads `req.serviceApp.appId` (set by serviceAuthMiddleware) and
 * resolves it through the short-TTL cache. Returns an empty set if the app id
 * is missing — the caller treats an empty set as "deny everything".
 */
async function getAllowedDomainsForRequest(req: ServiceAuthRequest): Promise<Set<string>> {
  const appId = req.serviceApp?.appId;
  if (typeof appId !== 'string' || appId.length === 0) {
    return new Set<string>();
  }
  return credentialDomainCache.getAllowedDomains(appId, () => loadAllowedDomains(appId));
}

/** Assert the requesting credential carries the federation:write scope. */
function assertFederationScope(req: ServiceAuthRequest): void {
  const scopes = req.serviceApp?.scopes ?? [];
  if (!scopes.includes(REQUIRED_SCOPE)) {
    throw new ForbiddenError(`Missing required scope: ${REQUIRED_SCOPE}`);
  }
}

/** The two account columns every guard on this bridge decides on. */
type BridgeUser = Pick<typeof users.$inferSelect, 'type' | 'accountStatus'>;

/**
 * Load the `type` / `accountStatus` an anti-impersonation guard needs, or null
 * when no such account exists.
 *
 * Two named columns, not `select()`: `users` carries protected columns
 * (`db/schema/protectedColumns.ts` — the raw phone number, the
 * contact-discovery hashes, the refresh token) which a whole-row read would
 * hand to a route that has no use for any of them.
 */
async function loadBridgeUser(userId: string): Promise<BridgeUser | null> {
  const [user] = await getDb()
    .select({ type: users.type, accountStatus: users.accountStatus })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return user ?? null;
}

/**
 * GET /federation/public-key/:username?domain=<domain>
 *
 * Returns the PUBLIC half of the domain-scoped user key so a relying app (e.g.
 * Mention) can publish a spec-compliant `publicKey` block whose `id`/`owner`
 * live on its own domain. NEVER returns privateKeyPem.
 *
 * The requested `domain` MUST be one of the requesting credential's registered
 * federation hosts (derived from the Application's redirectUris), otherwise 403.
 */
router.get(
  '/public-key/:username',
  serviceAuthMiddleware,
  validate({ params: publicKeyParamsSchema, query: publicKeyQuerySchema }),
  asyncHandler(async (req: ServiceAuthRequest, res: Response) => {
    assertFederationScope(req);

    const { username } = req.params as unknown as PublicKeyParams;
    const { domain } = req.query as unknown as PublicKeyQuery;

    const allowed = await getAllowedDomainsForRequest(req);
    if (!allowed.has(domain.trim().toLowerCase())) {
      logger.warn('federation/public-key: domain not authorised for credential', {
        appId: req.serviceApp?.appId,
        credentialId: req.serviceApp?.credentialId,
        domain,
      });
      throw new ForbiddenError('domain is not registered for this application');
    }

    const publicKey = await getUserPublicKey(username, domain);
    return sendSuccess(res, {
      keyId: publicKey.keyId,
      publicKeyPem: publicKey.publicKeyPem,
    });
  }),
);

/**
 * POST /federation/sign
 *
 * Signs an HTTP-Signature signing string with the private key identified by
 * `keyId`. The private key NEVER leaves Oxy — only the base64 signature is
 * returned (sign-on-behalf).
 *
 * Validation order (each rejecting before the next):
 *  - federation:write scope            → 403
 *  - body schema (keyId is an https #main-key url; signingString begins with
 *    "(request-target):" and is <= MAX_SIGNING_STRING_LENGTH)  → 400 (validate)
 *  - keyId host == one of the credential's registered domains   → 403
 *  - key pair for keyId exists (no auto-create on the sign path) → 404
 */
router.post(
  '/sign',
  serviceAuthMiddleware,
  validate({ body: signRequestSchema }),
  asyncHandler(async (req: ServiceAuthRequest, res: Response) => {
    assertFederationScope(req);

    const { keyId, signingString } = req.body as SignRequestBody;

    // keyId is already validated as an https URL ending in #main-key by the
    // schema; parsing here cannot throw, but guard defensively so the host check
    // is unambiguous.
    let keyIdHost: string;
    try {
      keyIdHost = new URL(keyId).hostname.toLowerCase();
    } catch {
      throw new ForbiddenError('keyId host is not authorised for this application');
    }

    const allowed = await getAllowedDomainsForRequest(req);
    if (!allowed.has(keyIdHost)) {
      logger.warn('federation/sign: keyId host not authorised for credential', {
        appId: req.serviceApp?.appId,
        credentialId: req.serviceApp?.credentialId,
        keyIdHost,
      });
      throw new ForbiddenError('keyId host is not authorised for this application');
    }

    const signature = await signWithKeyId(keyId, signingString);
    if (signature === null) {
      throw new NotFoundError('No key pair exists for the requested keyId');
    }

    return sendSuccess(res, {
      keyId,
      algorithm: 'rsa-sha256',
      signature,
    });
  }),
);

/**
 * POST /federation/follow
 *
 * Mirrors an inbound ActivityPub Follow/Undo-Follow into the Oxy follow graph on
 * behalf of a FEDERATED actor: when a remote actor follows (or unfollows) a
 * local user, Mention's backend calls this to create/remove the corresponding
 * Oxy edge. Idempotent — repeated calls never double-move the follower/following
 * counters.
 *
 * ANTI-IMPERSONATION: `followerUserId` MUST resolve to a `type:'federated'`
 * user. A service credential must never be able to move a LOCAL user's follow
 * graph — only the user themselves (via their own session) may do that. The
 * target must be a real, non-federated (local) user.
 */
router.post(
  '/follow',
  serviceAuthMiddleware,
  validate({ body: federationFollowSchema }),
  asyncHandler(async (req: ServiceAuthRequest, res: Response) => {
    assertFederationScope(req);

    const { followerUserId, targetUserId, action } = req.body as FederationFollowBody;

    const [follower, target] = await Promise.all([
      loadBridgeUser(followerUserId),
      loadBridgeUser(targetUserId),
    ]);

    if (!follower) {
      throw new NotFoundError('follower user not found');
    }
    // Only a federated actor's graph may be moved by a service credential.
    if (follower.type !== 'federated') {
      throw new ForbiddenError('follower must be a federated user');
    }
    if (follower.accountStatus === 'archived') {
      throw new ConflictError('follower is archived');
    }
    if (!target) {
      throw new NotFoundError('target user not found');
    }
    if (target.accountStatus === 'archived') {
      throw new ConflictError('target is archived');
    }
    // A federated actor may only follow a local user through this bridge.
    if (target.type === 'federated') {
      throw new ForbiddenError('target must be a local (non-federated) user');
    }

    if (action === 'follow') {
      const { created, counts } = await userService.followUser(followerUserId, targetUserId);
      return sendSuccess(res, { created, counts });
    }

    const { removed, counts } = await userService.unfollowUser(followerUserId, targetUserId);
    return sendSuccess(res, { removed, counts });
  }),
);

/**
 * POST /federation/actor-gone
 *
 * Marks a dead remote fediverse identity gone. Mention is the only component
 * that talks to the remote fediverse; when it receives an HTTP 410 Gone for an
 * actor (the remote Mastodon/Bluesky account was deleted) it calls this to
 * archive the corresponding Oxy user, so the dead identity leaves Oxy's
 * discovery/search surfaces instead of lingering as a 0-post ghost profile.
 *
 * SAFETY: the user document is NEVER hard-deleted — archival mirrors
 * `accountService.archiveAccount` (set `accountStatus: 'archived'`, invalidate
 * the user cache), so Oxy keeps the archived identity and Mention keeps its
 * FederatedActor tombstone; the follow-graph edges survive intact.
 *
 * ANTI-FOOTGUN: only a `type:'federated'` user may be archived here. Archiving a
 * local/agent/automated account would silently disable a real account, so a
 * non-federated target is rejected with 409 and never written.
 *
 * Idempotent: an already-archived actor returns 200 with `alreadyArchived:true`
 * and performs no write.
 */
router.post(
  '/actor-gone',
  serviceAuthMiddleware,
  validate({ body: federationActorGoneSchema }),
  asyncHandler(async (req: ServiceAuthRequest, res: Response) => {
    assertFederationScope(req);

    const { oxyUserId } = req.body as FederationActorGoneBody;

    const user = await loadBridgeUser(oxyUserId);
    if (!user) {
      throw new NotFoundError('user not found');
    }
    // HARD GUARD: never archive a local/agent/automated account through this
    // service bridge — only a dead remote fediverse actor.
    if (user.type !== 'federated') {
      throw new ConflictError('user is not a federated actor and cannot be archived');
    }

    // Idempotent: an already-archived actor is a no-op 200.
    const alreadyArchived = user.accountStatus === 'archived';
    if (!alreadyArchived) {
      // Whitelist the single field; the `type = 'federated'` predicate re-asserts
      // the guard atomically so a concurrent type change can never let the write
      // touch a non-federated account.
      await getDb()
        .update(users)
        .set({ accountStatus: 'archived' })
        .where(and(eq(users.id, oxyUserId), eq(users.type, 'federated')));
      userCache.invalidate(oxyUserId);
      logger.info('federation/actor-gone: archived dead federated actor', {
        oxyUserId,
        appId: req.serviceApp?.appId,
        credentialId: req.serviceApp?.credentialId,
      });
    }

    return sendSuccess(res, {
      oxyUserId,
      accountStatus: 'archived',
      alreadyArchived,
    });
  }),
);

/**
 * POST /federation/actor-delete
 *
 * HARD-DELETES a dead remote fediverse identity and purges its Oxy follow-graph
 * edges. Mention calls this after an actor is permanently removed upstream (HTTP
 * 410 Gone for a deleted/spam account) to erase the ghost identity and its
 * social-graph residue from Oxy entirely — the irreversible counterpart to
 * `actor-gone` (which only archives, keeping the row).
 *
 * ANTI-FOOTGUN: only a `type:'federated'` user may be deleted here. The route
 * loads the user and rejects a non-federated target with 409 BEFORE any
 * destructive write; `userService.deleteFederatedActor` additionally re-asserts
 * `type = 'federated'` in the terminal `delete from users` predicate, so a real
 * account can never be hard-deleted through this bridge even under a race.
 *
 * Idempotent: an already-deleted (or never-known) id is a 200 no-op with
 * `deleted:false` — NOT a 404 — so a retried delete after a partial success
 * always converges.
 */
router.post(
  '/actor-delete',
  serviceAuthMiddleware,
  validate({ body: federationActorDeleteSchema }),
  asyncHandler(async (req: ServiceAuthRequest, res: Response) => {
    assertFederationScope(req);

    const { oxyUserId } = req.body as FederationActorDeleteBody;

    const user = await loadBridgeUser(oxyUserId);
    // Idempotent: an unknown (or already-deleted) actor is a 200 no-op so a
    // retried delete converges instead of erroring.
    if (!user) {
      return sendSuccess(res, {
        oxyUserId,
        deleted: false,
        followEdgesRemoved: 0,
      });
    }
    // HARD GUARD: never hard-delete a local/agent/automated account through this
    // service bridge — only a dead remote fediverse actor.
    if (user.type !== 'federated') {
      throw new ConflictError('user is not a federated actor and cannot be deleted');
    }

    const { followEdgesRemoved } = await userService.deleteFederatedActor(oxyUserId);
    logger.info('federation/actor-delete: hard-deleted dead federated actor', {
      oxyUserId,
      followEdgesRemoved,
      appId: req.serviceApp?.appId,
      credentialId: req.serviceApp?.credentialId,
    });

    return sendSuccess(res, {
      oxyUserId,
      deleted: true,
      followEdgesRemoved,
    });
  }),
);

/**
 * Whether this deployment is ARMED for blocked-domain deletion.
 *
 * Deliberately separate from the request: `dryRun:false` says the caller
 * intends to delete, this says an operator has decided this environment may.
 * Both are required, so a confused, replayed or compromised caller cannot
 * destroy anything against a deployment nobody armed — and disarming is an env
 * change that needs no code deploy.
 *
 * Read per request rather than at module load so arming takes effect on the
 * next task start without a rebuild, and so tests can exercise both states.
 */
function isDomainPurgeArmed(): boolean {
  return process.env.FEDERATION_DOMAIN_PURGE_ENABLED === 'true';
}

/**
 * POST /federation/domain-purge
 *
 * Removes what the Oxy PLATFORM holds for a fediverse instance the calling app
 * has blocked: the app's mirrored media, the avatars Oxy fetched, and the
 * `type:'federated'` user rows themselves with their social-graph edges.
 *
 * Oxy holds NO blocklist and never will — the calling app owns that policy and
 * names one domain per call. The rationale, the ownership rules and the exact
 * host-matching semantics live in
 * `services/federation/blockedDomainPurge.service.ts`; this route is only the
 * authenticated door to them.
 *
 * WHOSE DATA: files are deleted only when their recorded `serviceAppId` is the
 * caller's own application id, taken from the SERVICE CREDENTIAL
 * (`req.serviceApp.appId`) and never from the request body — an app cannot ask
 * Oxy to delete another app's data. A user row shared with another application
 * is archived and kept, and the response names the apps that kept it.
 *
 * SAFE BY DEFAULT: `dryRun` defaults to true, so a caller that omits it gets a
 * plan. A real deletion needs `dryRun:false` AND
 * `FEDERATION_DOMAIN_PURGE_ENABLED=true` on the deployment; otherwise 409.
 *
 * BOUNDED AND RESUMABLE: at most `limit` actors (default 200) per call. The
 * response carries `done`, `nextCursor`, and `remaining` (informational only).
 * Loop until `done`, echoing `nextCursor` as `afterId` on each subsequent call.
 * Repeating a completed purge is a no-op, so a retry after a partial failure
 * converges.
 */
router.post(
  '/domain-purge',
  serviceAuthMiddleware,
  validate({ body: federationDomainPurgeSchema }),
  asyncHandler(async (req: ServiceAuthRequest, res: Response) => {
    assertFederationScope(req);

    const { domain, dryRun, limit, afterId } = req.body as FederationDomainPurgeBody;

    const callerAppId = req.serviceApp?.appId;
    if (typeof callerAppId !== 'string' || callerAppId.length === 0) {
      // Without a caller identity there is no way to tell whose files these
      // are, so a purge would delete rows while sparing every file. Refuse.
      throw new ForbiddenError('service credential does not resolve to an application');
    }

    if (!dryRun && !isDomainPurgeArmed()) {
      throw new ConflictError(
        'blocked-domain purge is not armed on this deployment (FEDERATION_DOMAIN_PURGE_ENABLED)',
      );
    }

    let result: Awaited<ReturnType<typeof purgeBlockedDomain>>;
    try {
      result = await purgeBlockedDomain({
        domain,
        callerAppId,
        dryRun,
        limit: limit ?? DEFAULT_PURGE_LIMIT,
        afterId,
      });
    } catch (error) {
      // An unpurgeable domain (our own apex, or one that canonicalises to
      // nothing) is a caller mistake about WHICH domain, not a server fault.
      if (error instanceof UnpurgeableDomainError) {
        throw new ConflictError(error.message);
      }
      throw error;
    }

    logger.info('federation/domain-purge: pass complete', {
      requestedDomain: result.requestedDomain,
      canonicalDomain: result.canonicalDomain,
      dryRun: result.dryRun,
      appId: callerAppId,
      credentialId: req.serviceApp?.credentialId,
      actorsProcessed: result.actorsProcessed,
      actorsDeleted: result.actorsDeleted,
      actorsRetained: result.actorsRetained.length,
      filesDeleted: result.filesDeleted,
      localFollowersAffected: result.localFollowersAffected,
      remaining: result.remaining,
      done: result.done,
    });

    return sendSuccess(res, result);
  }),
);

export default router;
