/**
 * The Oxy Keychain (ADR 0063, `docs/identity/keychain.md`): one end-to-end
 * encrypted vault per personal account. Mounted at `/keychain`.
 *
 * Oxy stores ciphertext, public keys, signatures and counters, and checks the
 * roster's rules on every write (`services/keychainRoster.ts`); it never
 * receives a vault key, an item's plaintext, a device's private key or the
 * recovery key, and no route accepts one.
 *
 * Every route, in this order:
 *  1. `authMiddleware` — a verified bearer;
 *  2. `requireAccountSecurityAccess` — a first-party device session, or an
 *     OxyOS `host.self` token (the platform's Settings and keychain service,
 *     ADR 0058); every other application token and every third-party session
 *     is refused;
 *  3. a PERSONAL account acting as ITSELF, else `403 KEYCHAIN_NOT_AVAILABLE`;
 *  4. a device session (what a member is bound to), else
 *     `403 KEYCHAIN_DEVICE_REQUIRED`;
 *  5. a per-account budget (reads, writes, enrollment creation).
 *
 * Answers use the `{ data }` envelope; refusals the API's error body with a
 * code from `KEYCHAIN_ERROR_CODES`. Nothing here is cacheable.
 */

import { Router, type Request, type Response } from 'express';
import { eq } from 'drizzle-orm';
import {
  IDENTITY_ERROR_CODES,
  IDENTITY_PROOF_ACTIONS,
  KEYCHAIN_ERROR_CODES,
  SIGN_IN_ERROR_CODES,
  keychainApproveRequestSchema,
  keychainApproverNonceRequestSchema,
  keychainCreateRequestSchema,
  keychainEnrollmentCreateRequestSchema,
  keychainEnrollmentParamsSchema,
  keychainItemDeleteRequestSchema,
  keychainItemParamsSchema,
  keychainItemPutRequestSchema,
  keychainItemsQuerySchema,
  keychainResetRequestSchema,
  keychainRevealRequestSchema,
  keychainRosterAppendRequestSchema,
  type KeychainApproveRequest,
  type KeychainApproverNonceRequest,
  type KeychainCreateRequest,
  type KeychainEnrollmentCreateRequest,
  type KeychainItemDeleteRequest,
  type KeychainItemPutRequest,
  type KeychainItemsQuery,
  type KeychainResetRequest,
  type KeychainRevealRequest,
  type KeychainRosterAppendRequest,
} from '@oxy.so/contracts';
import { getDb } from '../config/postgres';
import { users } from '../db/schema/users';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import { requireAccountSecurityAccess } from '../middleware/firstPartyDeviceAccess';
import { rateLimit } from '../middleware/rateLimiter';
import { validate } from '../middleware/validate';
import { asyncHandler, sendSuccess } from '../utils/asyncHandler';
import { ApiError, UnauthorizedError } from '../utils/error';
import { hashedIpKey } from '../utils/ipKey';
import { digestIdentityPayload, verifyIdentityProof } from '../services/identityProof.service';
import {
  appendRoster,
  approveEnrollment,
  cancelEnrollment,
  createEnrollment,
  createKeychain,
  deleteItem,
  listEnrollments,
  listItems,
  postApproverNonce,
  putItem,
  readEnrollment,
  readKeychainState,
  readOwnWrap,
  readRecoveryWrap,
  resetKeychain,
  revealDeviceNonce,
  vaultIdOf,
} from '../services/keychain.service';
import { verifyAccountReauth } from '../services/reauth.service';
import { isTotpEnabled, verifySecondFactor } from '../services/totp.service';

const router = Router();

const FIFTEEN_MINUTES = 15 * 60 * 1000;

/** A per-account budget; an IP key only where no account exists (never, past step 1). */
function accountLimiter(kind: string, windowMs: number, max: number) {
  return rateLimit({
    prefix: `rl:keychain:${kind}:`,
    windowMs,
    max,
    message: 'Too many keychain requests. Please try again shortly.',
    keyGenerator: (req: Request): string => {
      const userId = (req as AuthRequest).user?._id;
      return userId ? `keychain:${kind}:${userId}` : `keychain:${kind}:ip:${hashedIpKey(req)}`;
    },
  });
}

const readLimiter = accountLimiter('read', FIFTEEN_MINUTES, 600);
const writeLimiter = accountLimiter('write', FIFTEEN_MINUTES, 120);
const enrollmentLimiter = accountLimiter('enroll', 60 * 60 * 1000, 10);

/** The caller, as the keychain needs it: the account and the device session. */
interface KeychainCaller {
  accountId: string;
  deviceSessionId: string;
}

function callerOf(req: AuthRequest): KeychainCaller {
  const accountId = req.user?._id;
  const deviceSessionId = req.oxyToken?.deviceSessionId;
  if (!accountId || !deviceSessionId) throw new UnauthorizedError('Authentication required');
  return { accountId, deviceSessionId };
}

/**
 * A personal account acting as itself, through a device session. Every other
 * bearer (an organization, someone acting as another account, a token with no
 * device session) is refused before anything is read.
 */
function requireKeychainCaller(req: AuthRequest, res: Response, next: () => void): void {
  const token = req.oxyToken;
  const accountId = req.user?._id;
  if (!token || !accountId) {
    res.status(401).json({ error: 'UNAUTHORIZED', message: 'Authentication required' });
    return;
  }
  if (
    req.user?.kind !== 'personal' ||
    token.principalUserId !== token.subjectAccountId ||
    token.subjectAccountId !== accountId
  ) {
    res.status(403).json({
      error: KEYCHAIN_ERROR_CODES.notAvailable,
      message: 'The keychain belongs to a personal account, used as itself.',
    });
    return;
  }
  if (!token.deviceSessionId) {
    res.status(403).json({
      error: KEYCHAIN_ERROR_CODES.deviceRequired,
      message: 'The keychain is reached from a signed-in device.',
    });
    return;
  }
  next();
}

router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
router.use(authMiddleware, requireAccountSecurityAccess, requireKeychainCaller);

/* -------------------------------------------------------------------------- */
/*  The vault and its roster                                                  */
/* -------------------------------------------------------------------------- */

/** `GET /keychain` — the vault, its roster and members, and which member the caller is. */
router.get(
  '/',
  readLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { accountId, deviceSessionId } = callerOf(req);
    sendSuccess(res, await readKeychainState(accountId, deviceSessionId));
  }),
);

/** `POST /keychain` — make the vault from its genesis entry and the first two wraps. */
router.post(
  '/',
  writeLimiter,
  validate({ body: keychainCreateRequestSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { accountId, deviceSessionId } = callerOf(req);
    const body = req.body as KeychainCreateRequest;
    sendSuccess(
      res,
      await createKeychain(accountId, deviceSessionId, body.genesis, body.wraps),
      201,
    );
  }),
);

/** `POST /keychain/roster` — entries continuing the head, with the wraps they require. */
router.post(
  '/roster',
  writeLimiter,
  validate({ body: keychainRosterAppendRequestSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { accountId, deviceSessionId } = callerOf(req);
    const body = req.body as KeychainRosterAppendRequest;
    sendSuccess(res, await appendRoster(accountId, deviceSessionId, body.entries, body.wraps));
  }),
);

/** `GET /keychain/wrap` — the caller's own member's wrap. */
router.get(
  '/wrap',
  readLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { accountId, deviceSessionId } = callerOf(req);
    sendSuccess(res, { wrap: await readOwnWrap(accountId, deviceSessionId) });
  }),
);

/** `GET /keychain/recovery` — the recovery wrap, for any device of the account. */
router.get(
  '/recovery',
  readLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { accountId } = callerOf(req);
    sendSuccess(res, { wrap: await readRecoveryWrap(accountId) });
  }),
);

/**
 * `DELETE /keychain` — reset: delete the vault and everything under it, after
 * a fresh re-verification (ADR 0063 D6).
 *
 * An account without a linked root re-verifies as ADR 0030 says
 * (`reset_keychain`: its email code, its password when it has no email, plus
 * its authenticator's code). An account WITH a linked root (Commons) has no
 * email or password to re-verify with, so, as its other security writes, its
 * root signs: a one-use root proof for `keychain_reset` over `{ vaultId }`,
 * plus its authenticator's code when it has one. The vault's existence is
 * checked first, so a reset of nothing spends no factor.
 */
router.delete(
  '/',
  writeLimiter,
  validate({ body: keychainResetRequestSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { accountId } = callerOf(req);
    const body = req.body as KeychainResetRequest;
    const vaultId = await vaultIdOf(accountId);
    const [account] = await getDb()
      .select({ publicKey: users.publicKey })
      .from(users)
      .where(eq(users.id, accountId))
      .limit(1);
    const root = account?.publicKey?.trim().toLowerCase() || null;

    if (root) {
      const proof = body.rootProof;
      if (!proof) {
        throw new ApiError(
          401,
          'Confirm the reset with Commons first.',
          KEYCHAIN_ERROR_CODES.resetProofRequired,
        );
      }
      if (await isTotpEnabled(accountId)) {
        if (!body.totpCode) {
          throw new ApiError(
            401,
            'Enter the code from your authenticator app too.',
            SIGN_IN_ERROR_CODES.totpRequired,
          );
        }
        if (!(await verifySecondFactor(accountId, body.totpCode))) {
          throw new ApiError(
            401,
            'That authenticator code is not right.',
            SIGN_IN_ERROR_CODES.secondFactorInvalid,
          );
        }
      }
      await resetKeychain(accountId, vaultId, (tx) =>
        verifyIdentityProof(tx, {
          userId: accountId,
          actor: accountId,
          action: IDENTITY_PROOF_ACTIONS.keychainReset,
          rootPublicKey: root,
          mintedRoot: root,
          payloadDigest: digestIdentityPayload({ vaultId }),
          expectedRevision: null,
          proof,
        }),
      );
    } else {
      if (body.rootProof) {
        throw new ApiError(
          400,
          'This account has no linked root to confirm with.',
          IDENTITY_ERROR_CODES.proofInvalid,
        );
      }
      await verifyAccountReauth(accountId, body.reauth, 'reset_keychain');
      await resetKeychain(accountId, vaultId, async () => {});
    }
    res.status(204).end();
  }),
);

/* -------------------------------------------------------------------------- */
/*  Enrollments                                                               */
/* -------------------------------------------------------------------------- */

/** `POST /keychain/enrollments` — a new device asks to join, committing to its nonce. */
router.post(
  '/enrollments',
  writeLimiter,
  enrollmentLimiter,
  validate({ body: keychainEnrollmentCreateRequestSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { accountId, deviceSessionId } = callerOf(req);
    const body = req.body as KeychainEnrollmentCreateRequest;
    const enrollment = await createEnrollment(
      accountId,
      deviceSessionId,
      body.member,
      body.commitment,
    );
    sendSuccess(res, { enrollment }, 201);
  }),
);

/** `GET /keychain/enrollments` — the pending requests, for a member. */
router.get(
  '/enrollments',
  readLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { accountId, deviceSessionId } = callerOf(req);
    sendSuccess(res, { enrollments: await listEnrollments(accountId, deviceSessionId) });
  }),
);

/** `GET /keychain/enrollments/:id` — for the enrolling device or a member. */
router.get(
  '/enrollments/:id',
  readLimiter,
  validate({ params: keychainEnrollmentParamsSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { accountId, deviceSessionId } = callerOf(req);
    const enrollment = await readEnrollment(accountId, deviceSessionId, req.params.id as string);
    sendSuccess(res, { enrollment });
  }),
);

/** `POST /keychain/enrollments/:id/approver-nonce` — a member opens the request. */
router.post(
  '/enrollments/:id/approver-nonce',
  writeLimiter,
  validate({ params: keychainEnrollmentParamsSchema, body: keychainApproverNonceRequestSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { accountId, deviceSessionId } = callerOf(req);
    const body = req.body as KeychainApproverNonceRequest;
    const enrollment = await postApproverNonce(
      accountId,
      deviceSessionId,
      req.params.id as string,
      body.memberId,
      body.approverNonce,
    );
    sendSuccess(res, { enrollment });
  }),
);

/** `POST /keychain/enrollments/:id/reveal` — the enrolling device reveals its nonce. */
router.post(
  '/enrollments/:id/reveal',
  writeLimiter,
  validate({ params: keychainEnrollmentParamsSchema, body: keychainRevealRequestSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { accountId, deviceSessionId } = callerOf(req);
    const body = req.body as KeychainRevealRequest;
    const enrollment = await revealDeviceNonce(
      accountId,
      deviceSessionId,
      req.params.id as string,
      body.deviceNonce,
    );
    sendSuccess(res, { enrollment });
  }),
);

/** `POST /keychain/enrollments/:id/approve` — the approver adds the device. */
router.post(
  '/enrollments/:id/approve',
  writeLimiter,
  validate({ params: keychainEnrollmentParamsSchema, body: keychainApproveRequestSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { accountId, deviceSessionId } = callerOf(req);
    const body = req.body as KeychainApproveRequest;
    const state = await approveEnrollment(
      accountId,
      deviceSessionId,
      req.params.id as string,
      body.entry,
      body.wrap,
    );
    sendSuccess(res, state);
  }),
);

/** `DELETE /keychain/enrollments/:id` — withdrawn by its device, or refused by a member. */
router.delete(
  '/enrollments/:id',
  writeLimiter,
  validate({ params: keychainEnrollmentParamsSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { accountId, deviceSessionId } = callerOf(req);
    await cancelEnrollment(accountId, deviceSessionId, req.params.id as string);
    res.status(204).end();
  }),
);

/* -------------------------------------------------------------------------- */
/*  Items                                                                     */
/* -------------------------------------------------------------------------- */

/** `GET /keychain/items?since=&limit=` — the changes after `since`, deletions included. */
router.get(
  '/items',
  readLimiter,
  validate({ query: keychainItemsQuerySchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { accountId, deviceSessionId } = callerOf(req);
    const query = req.query as unknown as KeychainItemsQuery;
    sendSuccess(res, await listItems(accountId, deviceSessionId, query.since, query.limit));
  }),
);

/** `PUT /keychain/items/:itemId` — create or replace, based on the revision the device had. */
router.put(
  '/items/:itemId',
  writeLimiter,
  validate({ params: keychainItemParamsSchema, body: keychainItemPutRequestSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { accountId, deviceSessionId } = callerOf(req);
    const body = req.body as KeychainItemPutRequest;
    const item = await putItem(accountId, deviceSessionId, req.params.itemId as string, body);
    sendSuccess(res, { item });
  }),
);

/** `DELETE /keychain/items/:itemId` — a tombstone, so every device's sync sees it. */
router.delete(
  '/items/:itemId',
  writeLimiter,
  validate({ params: keychainItemParamsSchema, body: keychainItemDeleteRequestSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { accountId, deviceSessionId } = callerOf(req);
    const body = req.body as KeychainItemDeleteRequest;
    const item = await deleteItem(
      accountId,
      deviceSessionId,
      req.params.itemId as string,
      body.baseRevision,
    );
    sendSuccess(res, { item });
  }),
);

export default router;
