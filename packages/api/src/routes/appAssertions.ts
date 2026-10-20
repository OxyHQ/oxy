/**
 * App assertions (ADR 0045): an Oxy app proves which app it is.
 *
 * Mounted at `/apps`. Every route takes the person's own bearer
 * (`authMiddleware`) and answers for that person and session only; the logic
 * and the order of refusals are in `services/appAssertion.service.ts`. A
 * refusal answers `{ error: <APP_ASSERTION_ERROR_CODES>, message }`.
 */

import express, { type Response } from 'express';
import {
  appAssertionChallengeRequestSchema,
  appAssertionRequestSchema,
  appAttestKeyRequestSchema,
  type AppAssertionChallengeRequest,
  type AppAssertionRequest,
  type AppAttestKeyRequest,
} from '@oxy.so/contracts';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimiter';
import { validate } from '../middleware/validate';
import {
  AppAssertionRefusal,
  appAssertionRuntime,
  issueAppAssertion,
  mintAppAssertionChallenge,
  registerAppAttestKey,
  type AppAssertionCaller,
} from '../services/appAssertion.service';
import { asyncHandler } from '../utils/asyncHandler';
import { hashedIpKey } from '../utils/ipKey';
import { logger } from '../utils/logger';

const router = express.Router();

/**
 * An app refreshes its assertion about every four minutes, plus a challenge on
 * a device: a person running several Oxy apps stays far below this.
 */
const appAssertionLimiter = rateLimit({
  prefix: 'rl:apps:assertions:',
  windowMs: 15 * 60 * 1000,
  max: 300,
  keyGenerator: (req) => (req as AuthRequest).user?.id ?? hashedIpKey(req),
});

/** The verified bearer, or `null` when the session did not resolve to a subject. */
function callerOf(req: AuthRequest): AppAssertionCaller | null {
  const token = req.oxyToken;
  if (!token || !req.sessionId || token.sessionId !== req.sessionId) return null;
  return {
    userId: token.subjectAccountId,
    sessionId: token.sessionId,
    sessionApplicationId: token.applicationId,
  };
}

async function answer(
  req: AuthRequest,
  res: Response,
  run: (caller: AppAssertionCaller) => Promise<unknown>,
  status = 200,
): Promise<void> {
  const caller = callerOf(req);
  if (!caller) {
    res.status(401).json({ error: 'unauthorized', message: 'A session bearer is required' });
    return;
  }
  try {
    res.status(status).json(await run(caller));
  } catch (error) {
    if (!(error instanceof AppAssertionRefusal)) throw error;
    // A refusal is a decision about a registry row or a session, never a fault,
    // and the response says only the code: log it, or "why is this app's
    // assertion 403?" has no answer short of reading the database.
    const body = req.body as { applicationId?: unknown; platform?: unknown } | undefined;
    logger.info('[app-assertion] refused', {
      code: error.code,
      route: req.path,
      applicationId: body?.applicationId,
      platform: body?.platform,
      origin: req.headers.origin,
      sessionApplicationId: caller.sessionApplicationId,
    });
    res.status(error.status).json({ error: error.code, message: error.message });
  }
}

/**
 * @openapi
 * /apps/assertions/challenge:
 *   post:
 *     tags: [Developer]
 *     summary: A single-use challenge for an Android or iOS app proof
 *     description: >-
 *       ADR 0045. Minted for this person, session, application, platform and purpose
 *       (`assertion`, or on iOS `attest_key` to register an App Attest key), valid for two
 *       minutes. The device hands `requestHash` to Play Integrity, or signs it with App
 *       Attest. `cloudProjectNumber` (Android) is the Google Cloud project to request the
 *       integrity token for. Refused when the application is not active, does not declare
 *       the platform, or the session belongs to another application.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             oneOf:
 *               - type: object
 *                 required: [applicationId, platform]
 *                 additionalProperties: false
 *                 properties:
 *                   applicationId: { type: string }
 *                   platform: { type: string, enum: [android] }
 *               - type: object
 *                 required: [applicationId, platform, purpose]
 *                 additionalProperties: false
 *                 properties:
 *                   applicationId: { type: string }
 *                   platform: { type: string, enum: [ios] }
 *                   purpose: { type: string, enum: [assertion, attest_key] }
 *     responses:
 *       200:
 *         description: The challenge (`AppAssertionChallengeResponse` in `@oxy.so/contracts`).
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [challenge, requestHash, expiresAt]
 *               properties:
 *                 challenge: { type: string }
 *                 requestHash: { type: string }
 *                 expiresAt: { type: string, format: date-time }
 *                 cloudProjectNumber: { type: string }
 *       401: { description: No session bearer. }
 *       403: { description: "`application_unavailable`, `session_other_application` or `platform_not_registered`." }
 *       503: { description: "`integrity_unconfigured`: Play Integrity is not configured." }
 */
router.post(
  '/assertions/challenge',
  authMiddleware,
  appAssertionLimiter,
  validate({ body: appAssertionChallengeRequestSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    await answer(req, res, (caller) =>
      mintAppAssertionChallenge(
        caller,
        req.body as AppAssertionChallengeRequest,
        appAssertionRuntime(),
      ),
    );
  }),
);

/**
 * @openapi
 * /apps/attest-keys:
 *   post:
 *     tags: [Developer]
 *     summary: Register an App Attest key for an iOS app
 *     description: >-
 *       ADR 0045. The attestation must chain to Apple's App Attestation Root CA, name the
 *       application's registered team and bundle (`rpIdHash`), the key id, a zero counter and
 *       an allowed environment, and carry the nonce of an `attest_key` challenge minted for
 *       this person and session. The challenge is spent before the attestation is verified.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [applicationId, keyId, challenge, attestation]
 *             additionalProperties: false
 *             properties:
 *               applicationId: { type: string }
 *               keyId: { type: string, description: Standard base64 of the key's SHA-256. }
 *               challenge: { type: string }
 *               attestation: { type: string, description: The attestation object, base64. }
 *     responses:
 *       201:
 *         description: Registered (`AppAttestKeyResponse` in `@oxy.so/contracts`).
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [keyId]
 *               properties:
 *                 keyId: { type: string }
 *       401: { description: No session bearer. }
 *       403: { description: "`application_unavailable`, `session_other_application`, `platform_not_registered`, `challenge_invalid` or `attestation_invalid`." }
 *       409: { description: "`attest_key_exists`." }
 */
router.post(
  '/attest-keys',
  authMiddleware,
  appAssertionLimiter,
  validate({ body: appAttestKeyRequestSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    await answer(
      req,
      res,
      (caller) =>
        registerAppAttestKey(caller, req.body as AppAttestKeyRequest, appAssertionRuntime()),
      201,
    );
  }),
);

/**
 * @openapi
 * /apps/assertions:
 *   post:
 *     tags: [Developer]
 *     summary: An Oxy-signed assertion of which app this is
 *     description: >-
 *       ADR 0045. Returns a five-minute `OXY-APP+JWT` (EdDSA, published at
 *       `/capabilities/.well-known/jwks.json`) with `iss`, `aud: oxy-apps`, `sub` (the person),
 *       `sid` (the session), `app` (the application), `platform`, `iat`, `exp` and `jti`. Send it
 *       as `X-Oxy-App-Assertion`. web: the request's `Origin` must be one of the application's
 *       web origins. android: a Play Integrity token over the `requestHash` of an `assertion`
 *       challenge, whose verdict names the registered package, a registered signing
 *       certificate and `PLAY_RECOGNIZED`. ios: an App Attest assertion over that `requestHash`
 *       with a registered key, its counter moving forward. A challenge is spent before the proof
 *       is verified, so a proof cannot be replayed.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             oneOf:
 *               - type: object
 *                 required: [applicationId, platform]
 *                 additionalProperties: false
 *                 properties:
 *                   applicationId: { type: string }
 *                   platform: { type: string, enum: [web] }
 *               - type: object
 *                 required: [applicationId, platform, proof]
 *                 additionalProperties: false
 *                 properties:
 *                   applicationId: { type: string }
 *                   platform: { type: string, enum: [android] }
 *                   proof:
 *                     type: object
 *                     required: [challenge, integrityToken]
 *                     properties:
 *                       challenge: { type: string }
 *                       integrityToken: { type: string }
 *               - type: object
 *                 required: [applicationId, platform, proof]
 *                 additionalProperties: false
 *                 properties:
 *                   applicationId: { type: string }
 *                   platform: { type: string, enum: [ios] }
 *                   proof:
 *                     type: object
 *                     required: [challenge, keyId, assertion]
 *                     properties:
 *                       challenge: { type: string }
 *                       keyId: { type: string }
 *                       assertion: { type: string, description: The App Attest assertion, base64. }
 *     responses:
 *       200:
 *         description: The assertion (`AppAssertionResponse` in `@oxy.so/contracts`).
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [assertion, applicationId, platform, expiresAt]
 *               properties:
 *                 assertion: { type: string }
 *                 applicationId: { type: string }
 *                 platform: { type: string, enum: [web, android, ios] }
 *                 expiresAt: { type: string, format: date-time }
 *       401: { description: No session bearer. }
 *       403: { description: "`application_unavailable`, `session_other_application`, `platform_not_registered`, `origin_not_registered`, `challenge_invalid`, `integrity_refused`, `attest_key_unknown` or `assertion_invalid`." }
 *       503: { description: "`integrity_unconfigured`, `integrity_unavailable` or `signing_unavailable`." }
 */
router.post(
  '/assertions',
  authMiddleware,
  appAssertionLimiter,
  validate({ body: appAssertionRequestSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    await answer(req, res, (caller) =>
      issueAppAssertion(caller, req.body as AppAssertionRequest, origin, appAssertionRuntime()),
    );
  }),
);

export default router;
