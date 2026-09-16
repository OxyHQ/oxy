/**
 * Web identity holder routes — the sealed web copy of an account's root.
 *
 * Mounted at `/identity/web-envelope`:
 *  - `GET    /`                   (bearer) the envelope, its revision and holder/readiness metadata
 *  - `PUT    /`                   (bearer + root proof) replace it, compare-and-swap on `revision`
 *  - `POST   /establish`          (bearer + root proof + fresh passkey assertion) link the account's FIRST root and store it, atomically
 *  - `POST   /phrase-confirmed`   (bearer + root proof) the recovery material is written down
 *  - `POST   /recovery-verified`  (bearer + root proof) the recovery material re-derived the root
 *  - `DELETE /`                   (bearer + root proof) remove the web holder
 *
 * NON-CUSTODIAL: the envelope is ciphertext the server cannot open — the secret
 * is sealed under a data key only a passkey's WebAuthn PRF output can unwrap.
 * ADR 0024 is the contract; `docs/identity/holders-and-recovery.md` the inventory.
 *
 * Guards beyond the bearer, each for a stated reason:
 *
 * 1. **Holder origin only.** Every call must come from the holder host
 *    (`IDENTITY_WEB_ORIGIN`) or loopback. Defense in depth — the proofs below
 *    are the control.
 * 2. **Current root only.** A write is refused unless the envelope seals the
 *    account's linked `users.public_key`; a read of an envelope sealing any other
 *    key returns nothing, so a rotated root cannot be resurrected.
 * 3. **A root proof on every write** (ADR 0024 D7): a signature over the canonical
 *    claims — action, account, root, the SHA-256 of the exact envelope, the
 *    revision it replaces — spending a one-use challenge from
 *    `POST /identity/proof-challenge`. A captured proof cannot write different
 *    bytes, replace a newer revision, or be replayed.
 * 4. **Compare-and-swap.** Two holder changes racing each other cannot silently
 *    drop one another's wrap: the loser gets 409 and re-reads.
 *
 * ROLLOUT WINDOW: the version-1 proof (`{signature, timestamp}` over
 * `{action,userId,timestamp}`) is still accepted so the holder host already
 * serving keeps working while this deploys. It is removed once the holder host
 * sends v2 (ADR 0024 D10); nothing re-enables it on rollback.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { and, eq, ne, sql } from 'drizzle-orm';
import {
  IDENTITY_ERROR_CODES,
  IDENTITY_PROOF_ACTIONS,
  webIdentityEnvelopeActionSchema,
  webIdentityEnvelopeEstablishSchema,
  webIdentityEnvelopePutSchema,
  type WebIdentityEnvelope,
  type WebIdentityEnvelopeAction,
  type WebIdentityEnvelopeEstablish,
  type WebIdentityEnvelopeProof,
  type WebIdentityEnvelopePut,
  type WebIdentityEnvelopeResponse,
  type WebIdentityWrap,
} from '@oxy.so/contracts';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError, BadRequestError, ForbiddenError, UnauthorizedError } from '../utils/error';
import { validate } from '../middleware/validate';
import { rateLimit } from '../middleware/rateLimiter';
import { hashedIpKey } from '../utils/ipKey';
import { isLoopbackOrigin } from '../utils/origin';
import { getIdentityWebOrigin } from '../config/env';
import { getDb, type DatabaseOrTransaction } from '../config/postgres';
import { identityWebEnvelopes } from '../db/schema/identityWebEnvelopes';
import { userAuthMethods } from '../db/schema/userAuthMethods';
import { users } from '../db/schema/users';
import { SignatureService } from '../services/signature.service';
import { digestIdentityPayload, verifyIdentityProof } from '../services/identityProof.service';
import { verifyFreshPasskeyAssertion } from '../services/webauthnFreshAssertion.service';
import { isUniqueViolation } from '../utils/postgresErrors';
import userCache from '../utils/userCache';
import { envelopeColumns } from '../utils/identityEnvelopeColumns';

const router = Router();

/** The version-1 actions (rollout window only). */
export const WEB_ENVELOPE_ACTIONS = {
  link: 'link_identity',
  put: 'web_envelope_put',
  phraseConfirmed: 'web_envelope_phrase_confirmed',
  delete: 'web_envelope_delete',
} as const;

/**
 * The exact bytes a version-1 proof signs — byte-identical to
 * `buildIdentityActionMessage` in `@oxy.so/core`.
 *
 * @deprecated Rollout window only; v2 proofs use `buildIdentityProofMessage`.
 */
export function buildWebEnvelopeProofMessage(action: string, userId: string, timestamp: number): string {
  return JSON.stringify({ action, userId, timestamp });
}

/** Whether a browser origin may reach the holder routes: the holder host, or loopback. */
export function isHolderOrigin(origin: string): boolean {
  return origin === getIdentityWebOrigin() || isLoopbackOrigin(origin);
}

/** Reject any browser origin other than the holder host (and loopback). */
function requireIdentityOrigin(req: Request, _res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !isHolderOrigin(origin)) {
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

function revisionConflict(): ApiError {
  return new ApiError(409, 'The identity changed since it was read — reload and try again', IDENTITY_ERROR_CODES.revisionConflict);
}

/** The account row, LOCKED, with its root lowercased. */
async function lockAccount(tx: DatabaseOrTransaction, userId: string): Promise<{ kind: string; root: string | null }> {
  const [account] = await tx
    .select({ kind: users.kind, publicKey: users.publicKey })
    .from(users)
    .where(eq(users.id, userId))
    .for('update')
    .limit(1);
  if (!account) {
    throw new BadRequestError('User not found');
  }
  return { kind: account.kind, root: account.publicKey?.trim().toLowerCase() || null };
}

/** The envelope row, LOCKED, or undefined. */
async function lockEnvelope(tx: DatabaseOrTransaction, userId: string): Promise<StoredEnvelope | undefined> {
  const [row] = await tx
    .select(ENVELOPE_COLUMNS)
    .from(identityWebEnvelopes)
    .where(eq(identityWebEnvelopes.userId, userId))
    .for('update')
    .limit(1);
  return row;
}

/** The linked root, lowercase, or `null` when none is linked. */
async function linkedPublicKey(userId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ publicKey: users.publicKey })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.publicKey ? row.publicKey.trim().toLowerCase() : null;
}

/** Check one fresh version-1 proof for `action` by `publicKey`. */
function assertV1Proof(userId: string, action: string, proof: WebIdentityEnvelopeProof, publicKey: string): void {
  if (!SignatureService.isTimestampFresh(proof.timestamp)) {
    throw new BadRequestError('Signature expired or invalid timestamp - please try again');
  }
  const message = buildWebEnvelopeProofMessage(action, userId, proof.timestamp);
  if (!SignatureService.verifySignature(message, proof.signature, publicKey)) {
    throw new UnauthorizedError('Invalid identity signature');
  }
}

/** `lower(btrim(public_key)) = lower(btrim($1))` — the spelling `users_lower_public_key_key` serves. */
function publicKeyMatches(candidate: string) {
  return sql`lower(btrim(${users.publicKey})) = lower(btrim(${candidate}))`;
}

const ENVELOPE_COLUMNS = {
  publicKey: identityWebEnvelopes.publicKey,
  version: identityWebEnvelopes.version,
  algorithm: identityWebEnvelopes.algorithm,
  secretKind: identityWebEnvelopes.secretKind,
  entropyNonce: identityWebEnvelopes.entropyNonce,
  sealedEntropy: identityWebEnvelopes.sealedEntropy,
  wraps: identityWebEnvelopes.wraps,
  phraseConfirmedAt: identityWebEnvelopes.phraseConfirmedAt,
  recoveryVerifiedAt: identityWebEnvelopes.recoveryVerifiedAt,
  revision: identityWebEnvelopes.revision,
  updatedAt: identityWebEnvelopes.updatedAt,
} as const;

interface StoredEnvelope {
  publicKey: string;
  version: number;
  algorithm: string;
  secretKind: 'mnemonic-entropy' | 'raw-private-key' | null;
  entropyNonce: string;
  sealedEntropy: string;
  wraps: WebIdentityWrap[];
  phraseConfirmedAt: Date | null;
  recoveryVerifiedAt: Date | null;
  revision: number;
  updatedAt: Date;
}

function storedToEnvelope(row: StoredEnvelope): WebIdentityEnvelope {
  if (row.version === 1) {
    return {
      version: 1,
      algorithm: 'xchacha20poly1305',
      publicKey: row.publicKey,
      entropyNonce: row.entropyNonce,
      sealedEntropy: row.sealedEntropy,
      wraps: row.wraps,
    };
  }
  return {
    version: 2,
    algorithm: 'xchacha20poly1305',
    publicKey: row.publicKey,
    secretKind: row.secretKind ?? 'mnemonic-entropy',
    secretNonce: row.entropyNonce,
    sealedSecret: row.sealedEntropy,
    wraps: row.wraps,
  };
}

function toResponse(row: StoredEnvelope | undefined, currentPublicKey: string | null): WebIdentityEnvelopeResponse {
  if (!row || !currentPublicKey || row.publicKey !== currentPublicKey) {
    return {
      envelope: null,
      revision: 0,
      rootLinked: currentPublicKey !== null,
      holders: [],
      phraseConfirmedAt: null,
      recoveryVerifiedAt: null,
      updatedAt: null,
    };
  }
  return {
    envelope: storedToEnvelope(row),
    revision: row.revision,
    rootLinked: true,
    holders: row.wraps.map((wrap) => ({
      credentialId: wrap.credentialId,
      rpId: wrap.rpId ?? null,
      verifiedAt: wrap.verifiedAt ?? null,
      createdAt: wrap.createdAt,
    })),
    phraseConfirmedAt: row.phraseConfirmedAt ? row.phraseConfirmedAt.toISOString() : null,
    recoveryVerifiedAt: row.recoveryVerifiedAt ? row.recoveryVerifiedAt.toISOString() : null,
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

/** The revision a proof must name: the stored one when it seals the current root, else 0 (nothing to replace). */
function currentRevision(row: StoredEnvelope | undefined, root: string): number {
  return row && row.publicKey === root ? row.revision : 0;
}

router.use(requireIdentityOrigin);

/** GET /identity/web-envelope — the caller's envelope, if it seals their current root. */
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
 * PUT /identity/web-envelope — replace the envelope (add or remove a wrap).
 *
 * Replacing keeps the readiness facts: re-wrapping the same root does not
 * un-save the recovery material.
 */
router.put(
  '/',
  authMiddleware,
  writeLimiter,
  validate({ body: webIdentityEnvelopePutSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const body = req.body as WebIdentityEnvelopePut;

    await getDb().transaction(async (tx) => {
      const { root } = await lockAccount(tx, userId);
      if (!root) {
        throw new ApiError(400, 'Account does not have an identity key', IDENTITY_ERROR_CODES.noRoot);
      }
      const existing = await lockEnvelope(tx, userId);
      const revision = currentRevision(existing, root);

      if ('proof' in body) {
        await verifyIdentityProof(tx, {
          userId,
          actor: userId,
          action: IDENTITY_PROOF_ACTIONS.put,
          rootPublicKey: root,
          mintedRoot: root,
          payloadDigest: digestIdentityPayload(body.envelope),
          expectedRevision: body.expectedRevision,
          proof: body.proof,
        });
        if (body.expectedRevision !== revision) throw revisionConflict();
      } else {
        assertV1Proof(userId, WEB_ENVELOPE_ACTIONS.put, body, root);
      }
      if (body.envelope.publicKey.toLowerCase() !== root) {
        throw new BadRequestError('The envelope does not seal this account’s identity');
      }

      const stored = envelopeColumns(body.envelope, root);
      if (existing && existing.publicKey === root) {
        await tx
          .update(identityWebEnvelopes)
          .set({ ...stored, revision: existing.revision + 1 })
          .where(eq(identityWebEnvelopes.userId, userId));
      } else {
        // No envelope, or one sealing a root this account no longer has: a fresh
        // holder whose readiness facts start over.
        await tx
          .insert(identityWebEnvelopes)
          .values({ userId, ...stored, revision: 1 })
          .onConflictDoUpdate({
            target: identityWebEnvelopes.userId,
            set: { ...stored, revision: (existing?.revision ?? 0) + 1, phraseConfirmedAt: null, recoveryVerifiedAt: null },
          });
      }
    });

    res.status(200).json(await readEnvelope(userId));
  }),
);

/**
 * POST /identity/web-envelope/establish — give a personal account with NO root
 * its first one: link the key and store the envelope in one transaction, so there
 * is never a committed link without a holder.
 *
 * v2 requires, besides the root proof, a fresh assertion by one of the account's
 * existing passkeys over the same challenge — a bearer is not a fresh factor.
 * An account whose root is already linked may add a web holder for THAT root
 * only when it has none; an account with a DIFFERENT root is refused.
 */
router.post(
  '/establish',
  authMiddleware,
  writeLimiter,
  validate({ body: webIdentityEnvelopeEstablishSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const body = req.body as WebIdentityEnvelopeEstablish;
    const publicKey = body.envelope.publicKey.toLowerCase();

    if (!('proof' in body)) {
      assertV1Proof(userId, WEB_ENVELOPE_ACTIONS.link, body.link, publicKey);
      assertV1Proof(userId, WEB_ENVELOPE_ACTIONS.put, body, publicKey);
    }

    try {
      await getDb().transaction(async (tx) => {
        const account = await lockAccount(tx, userId);
        if (account.kind !== 'personal') {
          throw new ApiError(403, 'Only a personal account has a root', IDENTITY_ERROR_CODES.notPersonal);
        }
        const current = account.root;
        if (current && current !== publicKey) {
          throw new ApiError(409, 'This account already has an identity', IDENTITY_ERROR_CODES.rootAlreadyLinked);
        }
        const existing = await lockEnvelope(tx, userId);

        if ('proof' in body) {
          if (current && existing && existing.publicKey === current) {
            // A holder already exists for this root; adding a wrap is a PUT.
            throw new ApiError(409, 'This account already has an identity', IDENTITY_ERROR_CODES.rootAlreadyLinked);
          }
          await verifyFreshPasskeyAssertion(tx, {
            userId,
            response: body.assertion,
            challengeHex: body.proof.challenge,
            allowOrigin: isHolderOrigin,
          });
          await verifyIdentityProof(tx, {
            userId,
            actor: userId,
            action: IDENTITY_PROOF_ACTIONS.establish,
            rootPublicKey: publicKey,
            mintedRoot: current,
            payloadDigest: digestIdentityPayload(body.envelope),
            expectedRevision: null,
            proof: body.proof,
          });
        }

        if (!current) {
          const [other] = await tx
            .select({ id: users.id })
            .from(users)
            .where(and(publicKeyMatches(publicKey), ne(users.id, userId)))
            .limit(1);
          if (other) {
            throw new ApiError(409, 'This identity is already linked to another account', IDENTITY_ERROR_CODES.rootLinkedElsewhere);
          }
          await tx.update(users).set({ publicKey }).where(eq(users.id, userId));
          const [method] = await tx
            .select({ id: userAuthMethods.id })
            .from(userAuthMethods)
            .where(and(eq(userAuthMethods.userId, userId), eq(userAuthMethods.type, 'identity')))
            .limit(1);
          if (!method) {
            await tx.insert(userAuthMethods).values({ userId, type: 'identity', methodPublicKey: publicKey });
          }
        }
        const stored = envelopeColumns(body.envelope, publicKey);
        await tx
          .insert(identityWebEnvelopes)
          .values({ userId, ...stored, revision: 1 })
          .onConflictDoUpdate({
            target: identityWebEnvelopes.userId,
            set: { ...stored, revision: (existing?.revision ?? 0) + 1, phraseConfirmedAt: null, recoveryVerifiedAt: null },
          });
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(409, 'This identity is already linked to another account', IDENTITY_ERROR_CODES.rootLinkedElsewhere);
      }
      throw error;
    }

    userCache.invalidate(userId);
    res.status(200).json(await readEnvelope(userId));
  }),
);

/**
 * One readiness fact, recorded with a root proof bound to the envelope revision
 * it describes. Neither changes a holder, so neither bumps the revision.
 */
function readinessRoute(action: 'web_envelope_phrase_confirmed' | 'web_envelope_recovery_verified', column: 'phraseConfirmedAt' | 'recoveryVerifiedAt') {
  return asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const body = req.body as WebIdentityEnvelopeAction;

    await getDb().transaction(async (tx) => {
      const { root } = await lockAccount(tx, userId);
      if (!root) {
        throw new ApiError(400, 'Account does not have an identity key', IDENTITY_ERROR_CODES.noRoot);
      }
      const existing = await lockEnvelope(tx, userId);
      if ('proof' in body) {
        await verifyIdentityProof(tx, {
          userId,
          actor: userId,
          action,
          rootPublicKey: root,
          mintedRoot: root,
          payloadDigest: null,
          expectedRevision: body.expectedRevision,
          proof: body.proof,
        });
        if (body.expectedRevision !== currentRevision(existing, root)) throw revisionConflict();
      } else {
        if (action !== IDENTITY_PROOF_ACTIONS.phraseConfirmed) {
          throw new ApiError(400, 'This operation needs a version-2 proof', IDENTITY_ERROR_CODES.proofInvalid);
        }
        assertV1Proof(userId, WEB_ENVELOPE_ACTIONS.phraseConfirmed, body, root);
      }
      if (!existing || existing.publicKey !== root) {
        throw new BadRequestError('No web identity to confirm');
      }
      await tx
        .update(identityWebEnvelopes)
        .set({ [column]: new Date() })
        .where(eq(identityWebEnvelopes.userId, userId));
    });

    res.status(200).json(await readEnvelope(userId));
  });
}

/** POST /identity/web-envelope/phrase-confirmed — the owner wrote the recovery material down. */
router.post(
  '/phrase-confirmed',
  authMiddleware,
  writeLimiter,
  validate({ body: webIdentityEnvelopeActionSchema }),
  readinessRoute(IDENTITY_PROOF_ACTIONS.phraseConfirmed, 'phraseConfirmedAt'),
);

/** POST /identity/web-envelope/recovery-verified — the recovery material re-derived this root. */
router.post(
  '/recovery-verified',
  authMiddleware,
  writeLimiter,
  validate({ body: webIdentityEnvelopeActionSchema }),
  readinessRoute(IDENTITY_PROOF_ACTIONS.recoveryVerified, 'recoveryVerifiedAt'),
);

/**
 * DELETE /identity/web-envelope — remove the web holder (the last step of
 * "keep only in Commons"). Idempotent. The root itself is untouched: it lives on
 * wherever else it is held. Removing this row does not erase copies that were
 * exported, synced or cached before.
 */
router.delete(
  '/',
  authMiddleware,
  writeLimiter,
  validate({ body: webIdentityEnvelopeActionSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const body = req.body as WebIdentityEnvelopeAction;

    await getDb().transaction(async (tx) => {
      const { root } = await lockAccount(tx, userId);
      if (!root) {
        throw new ApiError(400, 'Account does not have an identity key', IDENTITY_ERROR_CODES.noRoot);
      }
      const existing = await lockEnvelope(tx, userId);
      if ('proof' in body) {
        await verifyIdentityProof(tx, {
          userId,
          actor: userId,
          action: IDENTITY_PROOF_ACTIONS.delete,
          rootPublicKey: root,
          mintedRoot: root,
          payloadDigest: null,
          expectedRevision: body.expectedRevision,
          proof: body.proof,
        });
        if (body.expectedRevision !== currentRevision(existing, root)) throw revisionConflict();
      } else {
        assertV1Proof(userId, WEB_ENVELOPE_ACTIONS.delete, body, root);
      }
      await tx.delete(identityWebEnvelopes).where(eq(identityWebEnvelopes.userId, userId));
    });

    res.status(200).json({ success: true });
  }),
);

export default router;
