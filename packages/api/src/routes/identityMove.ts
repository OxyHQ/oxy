/**
 * Moving a web identity into Commons — the relay (`@oxy.so/contracts` `identityMove`).
 *
 * Mounted at `/identity/move`:
 *  - `POST   /`                    (bearer, identity origin) start a move: v2 sends a key COMMITMENT, v1 the key
 *  - `GET    /:moveId`             (public)   read the move: commitment, keys, sealed payload, receipt
 *  - `POST   /:moveId/join`        (public)   Commons registers its ephemeral key
 *  - `POST   /:moveId/reveal`      (bearer, identity origin) v2: the web reveals its key, after the join
 *  - `POST   /:moveId/seal`        (bearer, identity origin, identity-key proof) the web seals the identity
 *  - `POST   /:moveId/receipt`     (public, identity-key proof) Commons proves it holds the identity
 *  - `DELETE /:moveId`             (bearer, identity origin) cancel
 *
 * The relay never holds anything that decrypts the sealed identity: two
 * ephemeral public keys and an AEAD ciphertext keyed by their ECDH. The person
 * compares a 6-digit code derived from both keys on both screens, so a relay
 * that substituted a key is caught before anything is sealed. The ciphertext is
 * cleared as soon as the move completes.
 *
 * Every transition is a single conditional UPDATE on the expected status AND the
 * deadline, so two racing joins, a late seal or a replayed receipt change nothing.
 *
 * Protocol version 2 (`@oxy.so/contracts` `identityMove`) exists because in
 * version 1 this relay saw both keys before committing to anything and could
 * grind a substituted key until both codes matched. In version 2 the initiator
 * key is revealed only after the responder joined, against a commitment the
 * responder read first, and the receipt binds the ciphertext relayed. This
 * server enforces the ordering; the clients verify the cryptography themselves,
 * so a dishonest server gains nothing by skipping a check.
 */
import crypto from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { and, eq, gt, inArray, isNotNull, isNull } from 'drizzle-orm';
import {
  IDENTITY_MOVE_TTL_MS,
  buildMoveCiphertextDigestInput,
  buildMoveCommitmentInput,
  buildMoveReceiptMessageV2,
  identityMoveRevealRequestSchema,
  type IdentityMoveRevealRequest,
  identityMoveCreateRequestSchema,
  identityMoveIdSchema,
  identityMoveJoinRequestSchema,
  identityMoveReceiptRequestSchema,
  identityMoveSealRequestSchema,
  type IdentityMoveCreateRequest,
  type IdentityMoveCreateResponse,
  type IdentityMoveJoinRequest,
  type IdentityMoveReceiptRequest,
  type IdentityMoveSealRequest,
  type IdentityMoveState,
} from '@oxy.so/contracts';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import { asyncHandler } from '../utils/asyncHandler';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from '../utils/error';
import { validate } from '../middleware/validate';
import { rateLimit } from '../middleware/rateLimiter';
import { hashedIpKey } from '../utils/ipKey';
import { isLoopbackOrigin } from '../utils/origin';
import { getIdentityWebOrigin } from '../config/env';
import { getDb } from '../config/postgres';
import { identityMoves } from '../db/schema/identityMoves';
import { users } from '../db/schema/users';
import { SignatureService } from '../services/signature.service';
import { sha256Hex } from '../services/identityProof.service';

const router = Router();

/** The actions the identity key signs during a move — byte-identical to `@oxy.so/core` `buildMoveMessage`. */
export const IDENTITY_MOVE_SIGNED_ACTIONS = {
  seal: 'identity_move_seal',
  received: 'identity_move_received',
} as const;

export function buildMoveMessage(action: string, moveId: string, timestamp: number): string {
  return JSON.stringify({ action, moveId: moveId.toLowerCase(), timestamp });
}

function requireIdentityOrigin(req: Request, _res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || (origin !== getIdentityWebOrigin() && !isLoopbackOrigin(origin))) {
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

function assertSigned(publicKey: string, action: string, moveId: string, proof: { signature: string; timestamp: number }): void {
  if (!SignatureService.isTimestampFresh(proof.timestamp)) {
    throw new BadRequestError('Signature expired or invalid timestamp - please try again');
  }
  if (!SignatureService.verifySignature(buildMoveMessage(action, moveId, proof.timestamp), proof.signature, publicKey)) {
    throw new UnauthorizedError('Invalid identity signature');
  }
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
    protocolVersion: row.protocolVersion === 2 ? 2 : 1,
    initiatorCommitment: row.initiatorCommitment,
    initiatorCommitmentNonce: row.initiatorCommitmentNonce,
    publicKey: row.publicKey,
    initiatorEphemeralPublicKey: row.initiatorEphemeralPublicKey,
    responderEphemeralPublicKey: row.responderEphemeralPublicKey,
    nonce: row.status === 'sealed' ? row.nonce : null,
    ciphertext: row.status === 'sealed' ? row.ciphertext : null,
    receiptSignature: row.receiptSignature,
    receiptTimestamp: row.receiptTimestamp,
    expiresAt: row.expiresAt.toISOString(),
  };
}

/** POST /identity/move — start moving the caller's identity. */
router.post(
  '/',
  requireIdentityOrigin,
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
    await getDb()
      .insert(identityMoves)
      .values(
        'initiatorCommitment' in body
          ? { moveId, userId, publicKey, protocolVersion: 2, initiatorCommitment: body.initiatorCommitment, expiresAt }
          : { moveId, userId, publicKey, protocolVersion: 1, initiatorEphemeralPublicKey: body.initiatorEphemeralPublicKey.toLowerCase(), expiresAt },
      );
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
 * POST /identity/move/:moveId/reveal — version 2: the web reveals its ephemeral
 * key, which must open the commitment published at creation, and only once a
 * responder has joined.
 */
router.post(
  '/:moveId/reveal',
  requireIdentityOrigin,
  authMiddleware,
  ownerLimiter,
  validate({ body: identityMoveRevealRequestSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const moveId = parseMoveId(req.params.moveId);
    const body = req.body as IdentityMoveRevealRequest;
    const move = await loadMove(moveId);
    if (move.userId !== userId) throw new NotFoundError('Move not found');
    if (move.protocolVersion !== 2 || !move.initiatorCommitment) throw new ConflictError('This move has nothing to reveal');
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

/** POST /identity/move/:moveId/seal — the web seals the identity for the joined device. */
router.post(
  '/:moveId/seal',
  requireIdentityOrigin,
  authMiddleware,
  ownerLimiter,
  validate({ body: identityMoveSealRequestSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const moveId = parseMoveId(req.params.moveId);
    const body = req.body as IdentityMoveSealRequest;
    const move = await loadMove(moveId);
    if (move.userId !== userId) throw new NotFoundError('Move not found');
    const publicKey = await linkedPublicKey(userId);
    if (!publicKey || publicKey !== move.publicKey) throw new ConflictError('The identity changed since this move started');
    assertSigned(publicKey, IDENTITY_MOVE_SIGNED_ACTIONS.seal, moveId, body);

    const [sealed] = await getDb()
      .update(identityMoves)
      .set({ status: 'sealed', nonce: body.nonce, ciphertext: body.ciphertext })
      .where(
        and(
          eq(identityMoves.moveId, moveId),
          eq(identityMoves.status, 'joined'),
          // Version 2: nothing is sealed before the key it was sealed with is public.
          isNotNull(identityMoves.initiatorEphemeralPublicKey),
          gt(identityMoves.expiresAt, new Date()),
        ),
      )
      .returning();
    if (!sealed) throw new ConflictError('This move is not waiting to be sealed');
    res.status(200).json(toState(sealed));
  }),
);

/**
 * POST /identity/move/:moveId/receipt — Commons proves it now holds the identity.
 * Verified against the move's key AND the account's current key; completing
 * clears the ciphertext.
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
    let receiptTimestamp: number;
    if (move.protocolVersion === 2) {
      if (!('v' in body) || !move.nonce || !move.ciphertext || !move.initiatorEphemeralPublicKey || !move.responderEphemeralPublicKey) {
        throw new BadRequestError('This move needs a version-2 receipt');
      }
      const message = buildMoveReceiptMessageV2({
        moveId,
        rootPublicKey: move.publicKey,
        initiatorEphemeralPublicKey: move.initiatorEphemeralPublicKey,
        responderEphemeralPublicKey: move.responderEphemeralPublicKey,
        ciphertextDigest: sha256Hex(buildMoveCiphertextDigestInput({ nonce: move.nonce, ciphertext: move.ciphertext })),
      });
      if (!SignatureService.verifySignature(message, body.signature, move.publicKey)) {
        throw new UnauthorizedError('Invalid identity signature');
      }
      receiptTimestamp = Date.now();
    } else {
      if ('v' in body) throw new BadRequestError('This move needs a version-1 receipt');
      assertSigned(move.publicKey, IDENTITY_MOVE_SIGNED_ACTIONS.received, moveId, body);
      receiptTimestamp = body.timestamp;
    }

    const [completed] = await getDb()
      .update(identityMoves)
      .set({
        status: 'completed',
        receiptSignature: body.signature,
        receiptTimestamp,
        nonce: null,
        ciphertext: null,
      })
      .where(and(eq(identityMoves.moveId, moveId), eq(identityMoves.status, 'sealed')))
      .returning();
    if (!completed) throw new ConflictError('This move is not waiting for a receipt');
    res.status(200).json(toState(completed));
  }),
);

/** DELETE /identity/move/:moveId — the web gives up before completion. */
router.delete(
  '/:moveId',
  requireIdentityOrigin,
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
