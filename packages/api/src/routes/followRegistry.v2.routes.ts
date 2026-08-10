/**
 * `/v2/follow-targets` — the registry an application talks to.
 *
 * Distinct from `/v2/follows`, which is what a user's actions go through. These
 * routes are authorized on the APPLICATION's ownership of a namespace; they
 * never read or change what anybody follows.
 *
 * All three require `follow-targets:register`. That is deliberately one scope
 * and not three: an application that may define its kinds may define its
 * targets, and splitting them would produce a consent screen listing
 * distinctions no user can act on.
 */

import express, { type Response } from 'express';
import { eq } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { applications } from '../db/schema';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import { accountService } from '../services/account.service';
import {
  assertFollowScopes,
  missingFollowScope,
  resolveFollowCapability,
  type FollowCapability,
} from '../services/followCapability.service';
import {
  claimNamespace,
  ensureTarget,
  getKindCapabilities,
  listKindsForApplication,
  registerKind,
  type RegistryFailure,
} from '../services/followRegistry.service';
import { asyncHandler, sendSuccess } from '../utils/asyncHandler';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from '../utils/error';

const router = express.Router();

router.use(authMiddleware);

const REGISTER = ['follow-targets:register'] as const;

// Fails at boot if this stops being a follow scope.
assertFollowScopes(REGISTER);

async function requireRegistrar(req: AuthRequest): Promise<FollowCapability> {
  const userId = req.user?.id;
  const sessionId = req.sessionId;
  if (!userId || !sessionId) throw new UnauthorizedError('Authentication required');

  const result = await resolveFollowCapability(userId, sessionId);
  if (!result.ok) {
    throw new ForbiddenError(
      result.reason === 'no_application'
        ? 'This session was not created through an application authorization'
        : result.reason === 'application_inactive'
          ? 'This application is not active'
          : 'This application has not been granted access to the follow registry'
    );
  }

  const missing = missingFollowScope(result.capability, REGISTER);
  if (missing) throw new ForbiddenError(`Missing scope: ${missing}`);

  // A user's OAuth grant delegates follow operations; it does not make that
  // user an administrator of the application-global registry. Resolve the
  // application's owning account independently and require an administrative
  // role before treating the application id in the capability as write
  // authority for namespaces, kinds, or provider metadata.
  const [application] = await getDb()
    .select({ ownerAccountId: applications.ownerAccountId })
    .from(applications)
    .where(eq(applications.id, result.capability.applicationId))
    .limit(1);
  const access = application
    ? await accountService.resolveEffectiveAccess(userId, application.ownerAccountId)
    : null;
  if (!access || (access.role !== 'owner' && access.role !== 'admin')) {
    throw new ForbiddenError('Application owner or administrator access is required');
  }

  return result.capability;
}

/**
 * Turn a registry failure into the right status.
 *
 * `namespace_taken` is a 409 and not a 403 on purpose: the caller's permissions
 * are fine, the name is simply somebody else's — and telling them "forbidden"
 * would send them to ask for a scope that would not help.
 */
function raise(reason: RegistryFailure): never {
  switch (reason) {
    case 'namespace_taken':
      throw new ConflictError('That namespace belongs to another application');
    case 'namespace_not_owned':
      throw new ForbiddenError(
        'Your application does not own that namespace. Claim it first, or use one you own.'
      );
    case 'kind_not_owned':
      // Distinct from the above because claiming anything would not help: the
      // kind row itself belongs to another application.
      throw new ForbiddenError('That kind was registered by another application');
    case 'unknown_kind':
      throw new BadRequestError('That kind has not been registered');
    case 'invalid_namespace':
      throw new BadRequestError('A namespace is one lowercase segment, e.g. "mercaria"');
    case 'invalid_kind':
      throw new BadRequestError('A kind is "<namespace>.<thing>", e.g. "mercaria.store"');
    case 'metadata_too_large':
      throw new BadRequestError('Target metadata is too large');
    case 'invalid_uri':
      throw new BadRequestError('A target URI must be absolute');
    case 'local_user_mismatch':
      throw new BadRequestError('localUserId does not match the Oxy user in the URI');
    case 'unknown_local_user':
      throw new BadRequestError('No Oxy account exists for that user id');
  }
}

/**
 * POST /v2/follow-targets/namespaces  { namespace }
 *
 * Claim a prefix. First come, idempotent for the holder — an application that
 * runs its registration on every boot must not fail the second time.
 */
router.post(
  '/namespaces',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const capability = await requireRegistrar(req);
    const namespace = (req.body as { namespace?: unknown } | undefined)?.namespace;
    if (typeof namespace !== 'string') throw new BadRequestError('namespace is required');

    const result = await claimNamespace({ capability, namespace });
    if (!result.ok) raise(result.reason);
    sendSuccess(res, result.value);
  })
);

/**
 * POST /v2/follow-targets/kinds  { kind, label?, capabilities? }
 *
 * Declare what following something of this kind means. `capabilities.reverse`
 * is the privacy decision #809 requires each kind to make explicitly — a user's
 * followers are public, a hashtag's are nobody's business — and it defaults to
 * the private answer so a kind registered carelessly leaks nothing.
 */
router.post(
  '/kinds',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const capability = await requireRegistrar(req);
    const body = (req.body ?? {}) as {
      kind?: unknown;
      label?: unknown;
      capabilities?: unknown;
    };
    if (typeof body.kind !== 'string') throw new BadRequestError('kind is required');

    const result = await registerKind({
      capability,
      kind: body.kind,
      ...(typeof body.label === 'string' ? { label: body.label } : {}),
      ...(body.capabilities && typeof body.capabilities === 'object'
        ? { capabilities: body.capabilities as Parameters<typeof registerKind>[0]['capabilities'] }
        : {}),
    });
    if (!result.ok) raise(result.reason);
    sendSuccess(res, result.value);
  })
);

/** Every kind the calling application owns. For its own boot, and for a console. */
router.get(
  '/kinds',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const capability = await requireRegistrar(req);
    sendSuccess(res, { kinds: await listKindsForApplication(capability.applicationId) });
  })
);

/**
 * A kind's declared capabilities. Readable by any application holding the
 * registry scope, because a client that renders a follow of somebody else's
 * kind still has to know the verb and whether it federates.
 */
router.get(
  '/kinds/:kind',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    await requireRegistrar(req);
    const kind = await getKindCapabilities(req.params.kind);
    if (!kind) throw new NotFoundError('Kind not found');
    sendSuccess(res, kind);
  })
);

/**
 * POST /v2/follow-targets  { uri, kind, metadata?, providerReference?, localUserId? }
 *
 * Resolve a target by canonical URI, registering it the first time anyone asks.
 *
 * This is the call every application makes on the way into a screen. It is
 * idempotent on the URI, which is what makes two applications describing the
 * same fediverse actor arrive at ONE row — and therefore at one relationship
 * per user rather than one per app.
 */
router.post(
  '/',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const capability = await requireRegistrar(req);
    const body = (req.body ?? {}) as {
      uri?: unknown;
      kind?: unknown;
      metadata?: unknown;
      providerReference?: unknown;
      localUserId?: unknown;
    };
    if (typeof body.uri !== 'string') throw new BadRequestError('uri is required');
    if (typeof body.kind !== 'string') throw new BadRequestError('kind is required');

    const result = await ensureTarget({
      capability,
      uri: body.uri,
      kind: body.kind,
      ...(body.metadata && typeof body.metadata === 'object'
        ? { metadata: body.metadata as Record<string, unknown> }
        : {}),
      ...(typeof body.providerReference === 'string'
        ? { providerReference: body.providerReference }
        : {}),
      ...(typeof body.localUserId === 'string' ? { localUserId: body.localUserId } : {}),
    });
    if (!result.ok) raise(result.reason);
    sendSuccess(res, result.value);
  })
);

export default router;
