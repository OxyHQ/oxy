/**
 * Giving a web root to Commons — the relay (`@oxy.so/contracts` `identityMove`, ADR 0024 D6).
 *
 * Mounted at `/identity/move`:
 *  - `POST   /`                    (bearer, holder origin) start a move with a COMMITMENT to the web's ephemeral key
 *  - `GET    /:moveId`             (public)   read the move: commitment, keys, sealed payload, receipt
 *  - `POST   /:moveId/join`        (public)   Commons registers its ephemeral key
 *  - `POST   /:moveId/reveal`      (bearer, holder origin) the web reveals its key, only after the join
 *  - `POST   /:moveId/seal`        (bearer, holder origin, one-use root proof over the sealed bytes)
 *  - `POST   /:moveId/receipt`     (public, root signature) Commons proves it stored the root
 *  - `DELETE /:moveId`             (bearer, holder origin) cancel
 *
 * The relay never holds anything that decrypts the sealed root: a commitment,
 * two ephemeral public keys and an AEAD ciphertext keyed by their ECDH. The web's
 * key stays hidden behind the commitment until Commons joined, so this relay
 * cannot grind a substituted key into matching 6-digit codes; the receipt binds
 * the ciphertext actually relayed. This server enforces the ordering; both
 * clients verify the cryptography themselves, so skipping a check here gains a
 * dishonest server nothing.
 *
 * Every transition is a single conditional UPDATE on the expected status AND the
 * deadline, so two racing joins, a late seal or a replayed receipt change nothing.
 */
import crypto from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { and, eq, gt, inArray, isNotNull, isNull } from 'drizzle-orm';
import {
  IDENTITY_MOVE_TTL_MS,
  IDENTITY_PROOF_ACTIONS,
  buildMoveCiphertextDigestInput,
  buildMoveCommitmentInput,
  buildMoveReceiptMessage,
  buildMoveSealPayload,
  identityMoveCreateRequestSchema,
  identityMoveIdSchema,
  identityMoveJoinRequestSchema,
  identityMoveReceiptRequestSchema,
  identityMoveRevealRequestSchema,
  identityMoveSealRequestSchema,
  type IdentityMoveCreateRequest,
  type IdentityMoveCreateResponse,
  type IdentityMoveJoinRequest,
  type IdentityMoveReceiptRequest,
  type IdentityMoveRevealRequest,
  type IdentityMoveSealRequest,
  type IdentityMoveState,
} from '@oxy.so/contracts';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import { asyncHandler } from '../utils/asyncHandler';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from '../utils/error';
import { validate } from '../middleware/validate';
import { rateLimit } from '../middleware/rateLimiter';
import { hashedIpKey } from '../utils/ipKey';
import { getDb } from '../config/postgres';
import { identityMoves } from '../db/schema/identityMoves';
import { users } from '../db/schema/users';
import { SignatureService } from '../services/signature.service';
import { digestIdentityPayload, sha256Hex, verifyIdentityProof } from '../services/identityProof.service';
import { isHolderOrigin } from './identityWebEnvelope';

const router = Router();

function requireHolderOrigin(req: Request, _res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !isHolderOrigin(origin)) {
    next(new ForbiddenError('This endpoint is only available to the Oxy identity origin'));
    return;
  }
  next();
}

const publicLimiter = rateLimit({
  prefix: 'rl:identity:move:public:',
  windowMs: 60 * 1000,
  max: 60,
  message: 'Too many requests. Please try again shortly.',
  keyGenerator: (req: Request): string => `identity:move:public:ip:${hashedIpKey(req)}`,
});

const ownerLimiter = rateLimit({
  prefix: 'rl:identity:move:owner:',
  windowMs: 60 * 60 * 1000,
  max: 30,
  message: 'Too many identity moves. Please try again later.',
  keyGenerator: (req: Request): string => {
    const userId = (req as AuthRequest).user?.id;
    return userId ? `identity:move:owner:${userId}` : `identity:move:owner:ip:${hashedIpKey(req)}`;
  },
});

function requireUserId(req: AuthRequest): string {
  const userId = req.user?._id;
  if (!userId) throw new UnauthorizedError('Authentication required');
  return userId;
}

function parseMoveId(raw: string): string {
  const parsed = identityMoveIdSchema.safeParse(raw);
  if (!parsed.success) throw new BadRequestError('Invalid move id');
  return parsed.data;
}

async function linkedPublicKey(userId: string): Promise<string | null> {
  const [row] = await getDb().select({ publicKey: users.publicKey }).from(users).where(eq(users.id, userId)).limit(1);
  return row?.publicKey ? row.publicKey.trim().toLowerCase() : null;
}

type MoveRow = typeof identityMoves.$inferSelect;

async function loadMove(moveId: string): Promise<MoveRow> {
  const db = getDb();
  const [row] = await db.select().from(identityMoves).where(eq(identityMoves.moveId, moveId)).limit(1);
  if (!row) throw new NotFoundError('Move not found');
  // Lazy expiry: the verdict comes from the read, not the sweep.
  if (['pending', 'joined', 'sealed'].includes(row.status) && row.expiresAt <= new Date()) {
    const [expired] = await db
      .update(identityMoves)
      .set({ status: 'expired', nonce: null, ciphertext: null })
      .where(and(eq(identityMoves.id, row.id), inArray(identityMoves.status, ['pending', 'joined', 'sealed'])))
      .returning();
    return expired ?? row;
  }
  return row;
}

function toState(row: MoveRow): IdentityMoveState {
  return {
    moveId: row.moveId,
    status: row.status,
    initiatorCommitment: row.initiatorCommitment,
    initiatorCommitmentNonce: row.initiatorCommitmentNonce,
    publicKey: row.publicKey,
    initiatorEphemeralPublicKey: row.initiatorEphemeralPublicKey,
    responderEphemeralPublicKey: row.responderEphemeralPublicKey,
    nonce: row.status === 'sealed' ? row.nonce : null,
    ciphertext: row.status === 'sealed' ? row.ciphertext : null,
    receiptSignature: row.receiptSignature,
    expiresAt: row.expiresAt.toISOString(),
  };
}

/** POST /identity/move — start giving the caller's root to Commons, with a commitment only. */
router.post(
  '/',
  requireHolderOrigin,
  authMiddleware,
  ownerLimiter,
  validate({ body: identityMoveCreateRequestSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const body = req.body as IdentityMoveCreateRequest;
    const publicKey = await linkedPublicKey(userId);
    if (!publicKey) throw new BadRequestError('Account does not have an identity key');

    const moveId = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + IDENTITY_MOVE_TTL_MS);
    await getDb().insert(identityMoves).values({ moveId, userId, publicKey, initiatorCommitment: body.initiatorCommitment, expiresAt });
    const payload: IdentityMoveCreateResponse = { moveId, expiresAt: expiresAt.toISOString() };
    res.status(201).json(payload);
  }),
);

/** GET /identity/move/:moveId — public: the 128-bit id is the capability, and nothing here decrypts. */
router.get(
  '/:moveId',
  publicLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    res.status(200).json(toState(await loadMove(parseMoveId(req.params.moveId))));
  }),
);

/** POST /identity/move/:moveId/join — Commons registers its ephemeral key. First join wins. */
router.post(
  '/:moveId/join',
  publicLimiter,
  validate({ body: identityMoveJoinRequestSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const moveId = parseMoveId(req.params.moveId);
    const body = req.body as IdentityMoveJoinRequest;
    await loadMove(moveId);
    const [joined] = await getDb()
      .update(identityMoves)
      .set({ status: 'joined', responderEphemeralPublicKey: body.responderEphemeralPublicKey.toLowerCase() })
      .where(and(eq(identityMoves.moveId, moveId), eq(identityMoves.status, 'pending'), gt(identityMoves.expiresAt, new Date())))
      .returning();
    if (!joined) throw new ConflictError('This move is no longer waiting for a device');
    res.status(200).json(toState(joined));
  }),
);

/**
 * POST /identity/move/:moveId/reveal — the web reveals its ephemeral key, which
 * must open the commitment published at creation, and only once Commons joined.
 */
router.post(
  '/:moveId/reveal',
  requireHolderOrigin,
  authMiddleware,
  ownerLimiter,
  validate({ body: identityMoveRevealRequestSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const moveId = parseMoveId(req.params.moveId);
    const body = req.body as IdentityMoveRevealRequest;
    const move = await loadMove(moveId);
    if (move.userId !== userId) throw new NotFoundError('Move not found');
    const key = body.initiatorEphemeralPublicKey.toLowerCase();
    if (sha256Hex(buildMoveCommitmentInput(key, body.commitmentNonce)) !== move.initiatorCommitment) {
      throw new BadRequestError('The key does not match this move’s commitment');
    }
    const [revealed] = await getDb()
      .update(identityMoves)
      .set({ initiatorEphemeralPublicKey: key, initiatorCommitmentNonce: body.commitmentNonce.toLowerCase() })
      .where(
        and(
          eq(identityMoves.moveId, moveId),
          eq(identityMoves.status, 'joined'),
          isNull(identityMoves.initiatorEphemeralPublicKey),
          gt(identityMoves.expiresAt, new Date()),
        ),
      )
      .returning();
    if (!revealed) throw new ConflictError('This move is not waiting for the key');
    res.status(200).json(toState(revealed));
  }),
);

/**
 * POST /identity/move/:moveId/seal — the web seals the root for the joined
 * device, authorized by a one-use root proof over the move and the exact sealed
 * bytes. Nothing is sealed before the key it was sealed with is public.
 */
router.post(
  '/:moveId/seal',
  requireHolderOrigin,
  authMiddleware,
  ownerLimiter,
  validate({ body: identityMoveSealRequestSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const moveId = parseMoveId(req.params.moveId);
    const body = req.body as IdentityMoveSealRequest;
    const move = await loadMove(moveId);
    if (move.userId !== userId) throw new NotFoundError('Move not found');

    const sealed = await getDb().transaction(async (tx) => {
      const [account] = await tx.select({ publicKey: users.publicKey }).from(users).where(eq(users.id, userId)).for('update').limit(1);
      const root = account?.publicKey?.trim().toLowerCase() || null;
      if (!root || root !== move.publicKey) throw new ConflictError('The identity changed since this move started');
      await verifyIdentityProof(tx, {
        userId,
        actor: userId,
        action: IDENTITY_PROOF_ACTIONS.moveSeal,
        rootPublicKey: root,
        mintedRoot: root,
        payloadDigest: digestIdentityPayload(buildMoveSealPayload(moveId, body)),
        expectedRevision: null,
        proof: body.proof,
      });
      const [row] = await tx
        .update(identityMoves)
        .set({ status: 'sealed', nonce: body.nonce, ciphertext: body.ciphertext })
        .where(
          and(
            eq(identityMoves.moveId, moveId),
            eq(identityMoves.status, 'joined'),
            isNotNull(identityMoves.initiatorEphemeralPublicKey),
            gt(identityMoves.expiresAt, new Date()),
          ),
        )
        .returning();
      if (!row) throw new ConflictError('This move is not waiting to be sealed');
      return row;
    });
    res.status(200).json(toState(sealed));
  }),
);

/**
 * POST /identity/move/:moveId/receipt — Commons proves it stored the root: a
 * root signature over the move, both keys and the digest of the relayed
 * ciphertext. Verified against the move's key AND the account's current key;
 * completing clears the ciphertext.
 */
router.post(
  '/:moveId/receipt',
  publicLimiter,
  validate({ body: identityMoveReceiptRequestSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const moveId = parseMoveId(req.params.moveId);
    const body = req.body as IdentityMoveReceiptRequest;
    const move = await loadMove(moveId);
    if ((await linkedPublicKey(move.userId)) !== move.publicKey) {
      throw new ConflictError('The identity changed since this move started');
    }
    if (move.status !== 'sealed' || !move.nonce || !move.ciphertext || !move.initiatorEphemeralPublicKey || !move.responderEphemeralPublicKey) {
      throw new ConflictError('This move is not waiting for a receipt');
    }
    const message = buildMoveReceiptMessage({
      moveId,
      rootPublicKey: move.publicKey,
      initiatorEphemeralPublicKey: move.initiatorEphemeralPublicKey,
      responderEphemeralPublicKey: move.responderEphemeralPublicKey,
      ciphertextDigest: sha256Hex(buildMoveCiphertextDigestInput({ nonce: move.nonce, ciphertext: move.ciphertext })),
    });
    if (!SignatureService.verifySignature(message, body.signature, move.publicKey)) {
      throw new UnauthorizedError('Invalid identity signature');
    }

    const [completed] = await getDb()
      .update(identityMoves)
      .set({ status: 'completed', receiptSignature: body.signature, receiptTimestamp: Date.now(), nonce: null, ciphertext: null })
      .where(and(eq(identityMoves.moveId, moveId), eq(identityMoves.status, 'sealed')))
      .returning();
    if (!completed) throw new ConflictError('This move is not waiting for a receipt');
    res.status(200).json(toState(completed));
  }),
);

/** DELETE /identity/move/:moveId — the web gives up before completion. */
router.delete(
  '/:moveId',
  requireHolderOrigin,
  authMiddleware,
  ownerLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const moveId = parseMoveId(req.params.moveId);
    await getDb()
      .update(identityMoves)
      .set({ status: 'cancelled', nonce: null, ciphertext: null })
      .where(
        and(eq(identityMoves.moveId, moveId), eq(identityMoves.userId, userId), inArray(identityMoves.status, ['pending', 'joined', 'sealed'])),
      );
    res.status(200).json({ success: true });
  }),
);

export default router;
