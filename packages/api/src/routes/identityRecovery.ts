/**
 * Signed-out recovery — an existing account back from its root alone (ADR 0024 D5).
 *
 * Mounted at `/identity/recovery` (holder origin only):
 *  - `POST /challenge`  a one-use challenge that names no account
 *  - `POST /start`      a root proof over it → the account's id and passkey registration options
 *  - `POST /complete`   the new passkey + the root sealed under it + a second proof → session
 *
 * No passkey, session or email is needed, and none is a way around this: the only
 * authority is a signature by the account's CURRENT root. Oxy never sees the
 * recovery material or the root; a wrong root proves nothing and learns nothing.
 *
 * What recovery changes: the account gains one passkey, and its web holder is
 * REPLACED by an envelope sealed under that passkey (the old wraps sealed a data
 * key recovery cannot know). Existing passkeys stay; the person removes lost ones
 * in their account settings. The account id, username and everything bound to
 * them are untouched.
 */
import crypto from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { and, eq, gt, sql } from 'drizzle-orm';
import { generateRegistrationOptions, verifyRegistrationResponse, type RegistrationResponseJSON, type AuthenticatorTransportFuture } from '@simplewebauthn/server';
import { decodeClientDataJSON, isoUint8Array } from '@simplewebauthn/server/helpers';
import {
  IDENTITY_ERROR_CODES,
  IDENTITY_PROOF_ACTIONS,
  IDENTITY_RECOVERY_TTL_MS,
  identityRecoveryCompleteRequestSchema,
  identityRecoveryStartRequestSchema,
  type IdentityRecoveryChallengeResponse,
  type IdentityRecoveryCompleteRequest,
  type IdentityRecoveryStartRequest,
  type IdentityRecoveryStartResponse,
} from '@oxy.so/contracts';
import { getDb } from '../config/postgres';
import { getWebauthnRpId } from '../config/env';
import { identityRecoveryAttempts } from '../db/schema/identityRecoveryAttempts';
import { identityWebEnvelopes } from '../db/schema/identityWebEnvelopes';
import { userAuthMethods } from '../db/schema/userAuthMethods';
import { users } from '../db/schema/users';
import { webauthnCredentials } from '../db/schema/webauthnCredentials';
import { rateLimit } from '../middleware/rateLimiter';
import { validate } from '../middleware/validate';
import { digestIdentityPayload, sha256Hex, verifyIdentityProofSignature } from '../services/identityProof.service';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError, ForbiddenError } from '../utils/error';
import { envelopeColumns } from '../utils/identityEnvelopeColumns';
import { hashedIpKey } from '../utils/ipKey';
import { logger } from '../utils/logger';
import userCache from '../utils/userCache';
import { isHolderOrigin } from './identityWebEnvelope';
import { mintWebauthnSession } from './webauthn';

const router = Router();

const RP_NAME = 'Oxy';

function recoveryFailed(message = 'This recovery could not be completed. Start again.'): ApiError {
  return new ApiError(401, message, IDENTITY_ERROR_CODES.recoveryFailed);
}

function requireHolderOrigin(req: Request, _res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !isHolderOrigin(origin)) {
    next(new ForbiddenError('This endpoint is only available to auth.oxy.so'));
    return;
  }
  next();
}

function ipLimiter(name: string, max: number, windowMs: number) {
  return rateLimit({
    prefix: `rl:identity:recovery:${name}:`,
    windowMs,
    max,
    message: 'Too many recovery attempts. Please try again later.',
    keyGenerator: (req: Request): string => `identity:recovery:${name}:ip:${hashedIpKey(req)}`,
  });
}

const challengeLimiter = ipLimiter('challenge', 20, 60 * 60 * 1000);
const startLimiter = ipLimiter('start', 10, 60 * 60 * 1000);
const completeLimiter = ipLimiter('complete', 10, 60 * 60 * 1000);

router.use(requireHolderOrigin);

/** POST /identity/recovery/challenge — one use, bound to nothing yet. */
router.post(
  '/challenge',
  challengeLimiter,
  asyncHandler(async (_req: Request, res: Response) => {
    const challenge = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + IDENTITY_RECOVERY_TTL_MS);
    await getDb().insert(identityRecoveryAttempts).values({ challengeHash: sha256Hex(challenge), expiresAt });
    const body: IdentityRecoveryChallengeResponse = { challenge, expiresAt: expiresAt.getTime() };
    res.status(200).json(body);
  }),
);

/**
 * POST /identity/recovery/start — prove the root; learn the account.
 *
 * The signature is checked before anything is read, so a request without the
 * root learns nothing, and a failed proof and an unused root answer identically.
 */
router.post(
  '/start',
  startLimiter,
  validate({ body: identityRecoveryStartRequestSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as IdentityRecoveryStartRequest;
    const root = body.publicKey.toLowerCase();
    try {
      verifyIdentityProofSignature({
        action: IDENTITY_PROOF_ACTIONS.recoverStart,
        subject: `root:${root}`,
        actor: 'anonymous',
        rootPublicKey: root,
        payloadDigest: null,
        expectedRevision: null,
        proof: body.proof,
      });
    } catch {
      throw recoveryFailed();
    }

    const db = getDb();
    const [account] = await db
      .select({ id: users.id, username: users.username, kind: users.kind })
      .from(users)
      .where(sql`lower(btrim(${users.publicKey})) = ${root}`)
      .limit(1);
    if (!account || account.kind !== 'personal') {
      // The caller holds this root, so saying "no account uses it" reveals
      // nothing about anyone else.
      throw new ApiError(404, 'No Oxy account uses this identity', IDENTITY_ERROR_CODES.recoveryFailed);
    }

    const rpID = getWebauthnRpId();
    const existing = await db
      .select({ credentialID: webauthnCredentials.credentialID, transports: webauthnCredentials.transports })
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, account.id));
    const registrationOptions = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID,
      userName: account.username || account.id,
      userID: isoUint8Array.fromUTF8String(account.id),
      attestationType: 'none',
      excludeCredentials: existing.map((credential) => ({
        id: credential.credentialID,
        transports: (credential.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined,
      })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });

    const ticket = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + IDENTITY_RECOVERY_TTL_MS);
    const started = await db
      .update(identityRecoveryAttempts)
      .set({
        status: 'started',
        ticketHash: sha256Hex(ticket),
        userId: account.id,
        rootPublicKey: root,
        registrationChallenge: registrationOptions.challenge,
        expiresAt,
      })
      .where(
        and(
          eq(identityRecoveryAttempts.challengeHash, sha256Hex(body.proof.challenge)),
          eq(identityRecoveryAttempts.status, 'challenged'),
          gt(identityRecoveryAttempts.expiresAt, new Date()),
        ),
      )
      .returning({ id: identityRecoveryAttempts.id });
    if (started.length === 0) throw recoveryFailed();

    const response: IdentityRecoveryStartResponse = {
      ticket,
      accountId: account.id,
      username: account.username,
      registrationOptions: registrationOptions as unknown as Record<string, unknown>,
      expiresAt: expiresAt.getTime(),
    };
    res.status(200).json(response);
  }),
);

/**
 * POST /identity/recovery/complete — the new passkey, the root sealed under it,
 * and a session, in one transaction.
 */
router.post(
  '/complete',
  completeLimiter,
  validate({ body: identityRecoveryCompleteRequestSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as IdentityRecoveryCompleteRequest;
    const registration = body.response as unknown as RegistrationResponseJSON;
    const credentialId = typeof registration?.id === 'string' ? registration.id : null;
    if (!credentialId || typeof registration.response?.clientDataJSON !== 'string') throw recoveryFailed();

    let origin: string;
    try {
      const clientData = decodeClientDataJSON(registration.response.clientDataJSON) as { origin?: unknown; type?: unknown };
      if (typeof clientData.origin !== 'string' || clientData.type !== 'webauthn.create' || !isHolderOrigin(clientData.origin)) {
        throw new Error('origin');
      }
      origin = clientData.origin;
    } catch {
      throw recoveryFailed();
    }

    const rpID = getWebauthnRpId();
    const db = getDb();
    const account = await db.transaction(async (tx) => {
      const [attempt] = await tx
        .select({
          id: identityRecoveryAttempts.id,
          userId: identityRecoveryAttempts.userId,
          rootPublicKey: identityRecoveryAttempts.rootPublicKey,
          registrationChallenge: identityRecoveryAttempts.registrationChallenge,
        })
        .from(identityRecoveryAttempts)
        .where(
          and(
            eq(identityRecoveryAttempts.ticketHash, sha256Hex(body.ticket)),
            eq(identityRecoveryAttempts.status, 'started'),
            gt(identityRecoveryAttempts.expiresAt, new Date()),
          ),
        )
        .for('update')
        .limit(1);
      if (!attempt?.userId || !attempt.rootPublicKey || !attempt.registrationChallenge) throw recoveryFailed();
      const userId = attempt.userId;
      const root = attempt.rootPublicKey;

      // The root must still be the account's: a rotation in between voids the attempt.
      const [user] = await tx
        .select({ id: users.id, username: users.username, avatar: users.avatar, publicKey: users.publicKey, kind: users.kind })
        .from(users)
        .where(eq(users.id, userId))
        .for('update')
        .limit(1);
      if (!user || user.kind !== 'personal' || user.publicKey?.trim().toLowerCase() !== root) throw recoveryFailed();

      const envelope = body.envelope;
      if (
        envelope.publicKey.toLowerCase() !== root ||
        envelope.wraps.length !== 1 ||
        envelope.wraps[0].credentialId !== credentialId ||
        envelope.wraps[0].rpId !== rpID
      ) {
        throw new ApiError(400, 'The identity must be sealed with exactly the new passkey', IDENTITY_ERROR_CODES.enrollmentInvalid);
      }
      try {
        verifyIdentityProofSignature({
          action: IDENTITY_PROOF_ACTIONS.recoverComplete,
          subject: userId,
          actor: `credential:${credentialId}`,
          rootPublicKey: root,
          payloadDigest: digestIdentityPayload({ envelope }),
          expectedRevision: null,
          proof: body.proof,
        });
      } catch {
        throw recoveryFailed();
      }
      if (body.proof.challenge !== Buffer.from(attempt.registrationChallenge, 'base64url').toString('hex')) {
        throw recoveryFailed();
      }

      let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
      try {
        verification = await verifyRegistrationResponse({
          response: registration,
          expectedChallenge: attempt.registrationChallenge,
          expectedOrigin: origin,
          expectedRPID: rpID,
          // This passkey becomes a root holder under PRF, which only a verified
          // ceremony yields consistently.
          requireUserVerification: true,
        });
      } catch (error) {
        logger.warn('recovery passkey registration did not verify', {
          component: 'identityRecovery',
          error: error instanceof Error ? error.message : String(error),
        });
        throw recoveryFailed();
      }
      if (!verification.verified || !verification.registrationInfo || verification.registrationInfo.credential.id !== credentialId) {
        throw recoveryFailed();
      }
      const { credential, credentialDeviceType, credentialBackedUp, userVerified } = verification.registrationInfo;
      const name = body.deviceName?.trim() || 'Passkey';

      const completed = await tx
        .update(identityRecoveryAttempts)
        .set({ status: 'completed' })
        .where(and(eq(identityRecoveryAttempts.id, attempt.id), eq(identityRecoveryAttempts.status, 'started')))
        .returning({ id: identityRecoveryAttempts.id });
      if (completed.length === 0) throw recoveryFailed();

      await tx.insert(webauthnCredentials).values({
        userId,
        credentialID: credential.id,
        credentialPublicKey: Buffer.from(credential.publicKey),
        counter: credential.counter,
        transports: credential.transports,
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp,
        userVerified,
        name,
      });
      await tx.insert(userAuthMethods).values({ userId, type: 'webauthn', methodCredentialId: credential.id, methodName: name });

      const [previous] = await tx
        .select({ revision: identityWebEnvelopes.revision })
        .from(identityWebEnvelopes)
        .where(eq(identityWebEnvelopes.userId, userId))
        .for('update')
        .limit(1);
      const now = new Date();
      const stored = envelopeColumns(envelope, root);
      // The material that re-derived this root is, by construction, in the
      // person's hands: both readiness facts are true now.
      await tx
        .insert(identityWebEnvelopes)
        .values({ userId, ...stored, revision: 1, phraseConfirmedAt: now, recoveryVerifiedAt: now })
        .onConflictDoUpdate({
          target: identityWebEnvelopes.userId,
          set: { ...stored, revision: (previous?.revision ?? 0) + 1, phraseConfirmedAt: now, recoveryVerifiedAt: now },
        });
      return { id: user.id, username: user.username, avatar: user.avatar };
    });

    userCache.invalidate(account.id);
    await mintWebauthnSession(req, res, account, { deviceName: body.deviceName, deviceFingerprint: body.deviceFingerprint });
  }),
);

export default router;
