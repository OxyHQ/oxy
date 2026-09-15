/**
 * Web identity carrier routes — the sealed web copy of an account's identity.
 *
 * Mounted at `/identity/web-envelope`:
 *  - `GET    /`                  (bearer) the caller's envelope + phrase state
 *  - `PUT    /`                  (bearer + identity-key proof) store or replace it
 *  - `POST   /phrase-confirmed`  (bearer + identity-key proof) record that the phrase is saved
 *  - `DELETE /`                  (bearer + identity-key proof) destroy the web copy
 *
 * NON-CUSTODIAL: the envelope is ciphertext the server cannot open — the
 * mnemonic entropy is sealed under a data key that only a passkey's WebAuthn PRF
 * output can unwrap (`docs/superpowers/specs/2026-09-15-one-identity-two-carriers-design.md`).
 *
 * Three guards beyond the bearer, each for a stated reason:
 *
 * 1. **Identity origin only.** Every call must come from the identity carrier's
 *    origin (`IDENTITY_WEB_ORIGIN`, `https://id.oxy.so`) or loopback. A PRF output
 *    can be requested by any `*.oxy.so` page (the passkeys' RP ID is `oxy.so`),
 *    so no other origin is ever handed the ciphertext that output would open.
 *    First-party sessions carry no client binding (`azp`), so the origin is the
 *    available signal; it is defense in depth, not the primary control.
 * 2. **Current identity only.** A write is refused unless the envelope seals the
 *    account's linked `users.public_key`; a read of an envelope sealing any other
 *    key returns nothing. An envelope can never carry someone else's identity,
 *    nor resurrect a rotated or moved one.
 * 3. **Key proof on every write.** A stolen bearer must not be able to overwrite
 *    the envelope with garbage (destroying the web copy), mark a phrase as saved,
 *    or delete the envelope. Each write carries a fresh signature by the identity
 *    key over `JSON.stringify({ action, userId, timestamp })`.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { eq } from 'drizzle-orm';
import {
  webIdentityEnvelopeProofSchema,
  webIdentityEnvelopePutSchema,
  type WebIdentityEnvelope,
  type WebIdentityEnvelopeProof,
  type WebIdentityEnvelopePut,
  type WebIdentityEnvelopeResponse,
} from '@oxy.so/contracts';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import { asyncHandler } from '../utils/asyncHandler';
import { BadRequestError, ForbiddenError, UnauthorizedError } from '../utils/error';
import { validate } from '../middleware/validate';
import { rateLimit } from '../middleware/rateLimiter';
import { hashedIpKey } from '../utils/ipKey';
import { isLoopbackOrigin } from '../utils/origin';
import { getIdentityWebOrigin } from '../config/env';
import { getDb } from '../config/postgres';
import { identityWebEnvelopes } from '../db/schema/identityWebEnvelopes';
import { users } from '../db/schema/users';
import { SignatureService } from '../services/signature.service';

const router = Router();

/** The actions an identity-key proof may authorize on this router. */
export const WEB_ENVELOPE_ACTIONS = {
  put: 'web_envelope_put',
  phraseConfirmed: 'web_envelope_phrase_confirmed',
  delete: 'web_envelope_delete',
} as const;

/** The exact bytes a proof signs — byte-identical to `buildIdentityActionMessage` in `@oxy.so/core`. */
export function buildWebEnvelopeProofMessage(action: string, userId: string, timestamp: number): string {
  return JSON.stringify({ action, userId, timestamp });
}

/** Reject any browser origin other than the identity carrier's (and loopback). */
function requireIdentityOrigin(req: Request, _res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || (origin !== getIdentityWebOrigin() && !isLoopbackOrigin(origin))) {
    next(new ForbiddenError('This endpoint is only available to the Oxy identity origin'));
    return;
  }
  next();
}

function perUserLimiter(name: string, max: number) {
  return rateLimit({
    prefix: `rl:identity:web-envelope:${name}:`,
    windowMs: 60 * 60 * 1000,
    max,
    message: 'Too many identity requests. Please try again later.',
    keyGenerator: (req: Request): string => {
      const userId = (req as AuthRequest).user?.id;
      return userId ? `identity:web-envelope:${name}:${userId}` : `identity:web-envelope:${name}:ip:${hashedIpKey(req)}`;
    },
  });
}

const readLimiter = perUserLimiter('read', 120);
const writeLimiter = perUserLimiter('write', 30);

function requireUserId(req: AuthRequest): string {
  const userId = req.user?._id;
  if (!userId) {
    throw new UnauthorizedError('Authentication required');
  }
  return userId;
}

/** The account's linked identity key, lowercase, or `null` when none is linked. */
async function linkedPublicKey(userId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ publicKey: users.publicKey })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.publicKey ? row.publicKey.trim().toLowerCase() : null;
}

/** Verify a fresh identity-key proof for `action`, returning the linked key. */
async function verifyProof(userId: string, action: string, proof: WebIdentityEnvelopeProof): Promise<string> {
  const publicKey = await linkedPublicKey(userId);
  if (!publicKey) {
    throw new BadRequestError('Account does not have an identity key');
  }
  if (!SignatureService.isTimestampFresh(proof.timestamp)) {
    throw new BadRequestError('Signature expired or invalid timestamp - please try again');
  }
  const message = buildWebEnvelopeProofMessage(action, userId, proof.timestamp);
  if (!SignatureService.verifySignature(message, proof.signature, publicKey)) {
    throw new UnauthorizedError('Invalid identity signature');
  }
  return publicKey;
}

const ENVELOPE_COLUMNS = {
  publicKey: identityWebEnvelopes.publicKey,
  version: identityWebEnvelopes.version,
  algorithm: identityWebEnvelopes.algorithm,
  entropyNonce: identityWebEnvelopes.entropyNonce,
  sealedEntropy: identityWebEnvelopes.sealedEntropy,
  wraps: identityWebEnvelopes.wraps,
  phraseConfirmedAt: identityWebEnvelopes.phraseConfirmedAt,
  updatedAt: identityWebEnvelopes.updatedAt,
} as const;

interface StoredEnvelope {
  publicKey: string;
  version: number;
  algorithm: string;
  entropyNonce: string;
  sealedEntropy: string;
  wraps: WebIdentityEnvelope['wraps'];
  phraseConfirmedAt: Date | null;
  updatedAt: Date;
}

function toResponse(row: StoredEnvelope | undefined, currentPublicKey: string | null): WebIdentityEnvelopeResponse {
  if (!row || !currentPublicKey || row.publicKey !== currentPublicKey) {
    return { envelope: null, phraseConfirmedAt: null, updatedAt: null };
  }
  const envelope: WebIdentityEnvelope = {
    version: row.version as WebIdentityEnvelope['version'],
    algorithm: 'xchacha20poly1305',
    publicKey: row.publicKey,
    entropyNonce: row.entropyNonce,
    sealedEntropy: row.sealedEntropy,
    wraps: row.wraps,
  };
  return {
    envelope,
    phraseConfirmedAt: row.phraseConfirmedAt ? row.phraseConfirmedAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function readEnvelope(userId: string): Promise<WebIdentityEnvelopeResponse> {
  const [row] = await getDb()
    .select(ENVELOPE_COLUMNS)
    .from(identityWebEnvelopes)
    .where(eq(identityWebEnvelopes.userId, userId))
    .limit(1);
  return toResponse(row, await linkedPublicKey(userId));
}

router.use(requireIdentityOrigin);

/** GET /identity/web-envelope — the caller's envelope, if it seals their current identity. */
router.get(
  '/',
  authMiddleware,
  readLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    res.status(200).json(await readEnvelope(userId));
  }),
);

/**
 * PUT /identity/web-envelope — store or replace the envelope.
 *
 * Replacing keeps `phrase_confirmed_at`: adding a passkey re-wraps the same
 * identity, it does not un-save the phrase.
 */
router.put(
  '/',
  authMiddleware,
  writeLimiter,
  validate({ body: webIdentityEnvelopePutSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const body = req.body as WebIdentityEnvelopePut;
    const publicKey = await verifyProof(userId, WEB_ENVELOPE_ACTIONS.put, body);
    if (body.envelope.publicKey.toLowerCase() !== publicKey) {
      throw new BadRequestError('The envelope does not seal this account’s identity');
    }

    const stored = {
      publicKey,
      version: body.envelope.version,
      algorithm: body.envelope.algorithm,
      entropyNonce: body.envelope.entropyNonce.toLowerCase(),
      sealedEntropy: body.envelope.sealedEntropy.toLowerCase(),
      wraps: body.envelope.wraps,
    };
    await getDb()
      .insert(identityWebEnvelopes)
      .values({ userId, ...stored })
      .onConflictDoUpdate({ target: identityWebEnvelopes.userId, set: stored });

    res.status(200).json(await readEnvelope(userId));
  }),
);

/** POST /identity/web-envelope/phrase-confirmed — the owner saved the recovery phrase. */
router.post(
  '/phrase-confirmed',
  authMiddleware,
  writeLimiter,
  validate({ body: webIdentityEnvelopeProofSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const publicKey = await verifyProof(userId, WEB_ENVELOPE_ACTIONS.phraseConfirmed, req.body as WebIdentityEnvelopeProof);

    const updated = await getDb()
      .update(identityWebEnvelopes)
      .set({ phraseConfirmedAt: new Date() })
      .where(eq(identityWebEnvelopes.userId, userId))
      .returning({ publicKey: identityWebEnvelopes.publicKey });
    if (updated.length === 0 || updated[0].publicKey !== publicKey) {
      throw new BadRequestError('No web identity to confirm');
    }

    res.status(200).json(await readEnvelope(userId));
  }),
);

/**
 * DELETE /identity/web-envelope — destroy the web copy (the last step of moving
 * the identity into Commons). Idempotent. The identity itself is untouched: it
 * lives on wherever else it is carried.
 */
router.delete(
  '/',
  authMiddleware,
  writeLimiter,
  validate({ body: webIdentityEnvelopeProofSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    await verifyProof(userId, WEB_ENVELOPE_ACTIONS.delete, req.body as WebIdentityEnvelopeProof);
    await getDb().delete(identityWebEnvelopes).where(eq(identityWebEnvelopes.userId, userId));
    res.status(200).json({ success: true });
  }),
);

export default router;
