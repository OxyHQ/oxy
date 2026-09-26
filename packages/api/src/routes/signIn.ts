/**
 * Signing in and creating an account without a passkey, mounted under `/auth`:
 *
 *  - `POST /signin/email/start`    `{ identifier, device? }` → `{ requestId, requestSecret, expiresAt }`
 *  - `POST /signin/email/confirm`  `{ requestId, requestSecret, code, device? }` → session | second factor
 *  - `POST /signin/email/link`     auth.oxy.so: `{ token, device }` → `{ approved: true }`
 *  - `POST /signin/email/collect`  `{ requestId, requestSecret, device? }` → pending | session | second factor
 *  - `POST /signin/password`       `{ identifier, password, device? }` → session | second factor
 *  - `POST /signin/second-factor`  `{ challengeId, code, device? }` → session
 *  - `POST /signup`                `{ username, email, emailTicket, device? }` → session
 *
 * Only official Oxy apps and auth.oxy.so may call them (`requireOfficialOrigin`;
 * the link, auth.oxy.so only). Every limiter is keyed by the HASHED IP
 * (`hashedIpKey`); no IP is ever stored. Nothing here says whether an account
 * exists: an unknown identifier gets the same answer, the same work and the
 * same lockout as a known one. Codes, secrets and passwords are never logged.
 */
import { Router, type Request, type Response } from 'express';
import { sql } from 'drizzle-orm';
import {
  SIGN_IN_ERROR_CODES,
  emailSignInCollectRequestSchema,
  emailSignInConfirmRequestSchema,
  emailSignInLinkRequestSchema,
  emailSignInStartRequestSchema,
  isValidUsername,
  passwordSignInRequestSchema,
  secondFactorSignInRequestSchema,
  signUpRequestSchema,
  USERNAME_INVALID_MESSAGE,
  type EmailSignInCollectRequest,
  type EmailSignInConfirmRequest,
  type EmailSignInLinkRequest,
  type EmailSignInStartRequest,
  type PasswordSignInRequest,
  type SecondFactorSignInRequest,
  type SignUpRequest,
} from '@oxy.so/contracts';
import { isUniqueViolation } from '@oxy.so/db';
import { getDb } from '../config/postgres';
import { notifications } from '../db/schema/notifications';
import { users } from '../db/schema/users';
import { requireAuthWebOrigin, requireOfficialOrigin } from '../middleware/officialOrigin';
import { rateLimit } from '../middleware/rateLimiter';
import { validate } from '../middleware/validate';
import { spendSignupTicket } from '../services/accountEmail.service';
import {
  approveEmailSignInLink,
  collectEmailSignIn,
  confirmEmailSignIn,
  startEmailSignIn,
} from '../services/emailSignIn.service';
import { clearFailures, reserveAttempt } from '../services/loginLockout.service';
import { readPasswordHash, verifyPasswordOrDummy } from '../services/password.service';
import { PASSWORD_LOCKOUT_SCOPE, identifierLockoutKey } from '../services/reauth.service';
import { completeFirstFactor, completeSecondFactor, mintSignInSession } from '../services/signInSession.service';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError, BadRequestError, ConflictError } from '../utils/error';
import { hashedIpKey } from '../utils/ipKey';
import { logger } from '../utils/logger';
import { normalizeUsername } from '../utils/username';

const router = Router();

function ipLimiter(name: string, windowMs: number, max: number) {
  return rateLimit({
    prefix: `rl:auth:signin:${name}:`,
    windowMs,
    max,
    message: 'Too many attempts. Please try again later.',
    keyGenerator: (req: Request): string => `auth:signin:${name}:ip:${hashedIpKey(req)}`,
  });
}

const HOUR = 60 * 60 * 1000;
const startLimiter = ipLimiter('email-start', HOUR, 20);
const confirmLimiter = ipLimiter('email-confirm', HOUR, 60);
const linkLimiter = ipLimiter('email-link', HOUR, 30);
/** The dialog polls every 2 s for the link's 15 minutes. */
const collectLimiter = ipLimiter('email-collect', HOUR, 1200);
const passwordLimiter = ipLimiter('password', 15 * 60 * 1000, 30);
const secondFactorLimiter = ipLimiter('second-factor', 15 * 60 * 1000, 30);
const signupLimiter = ipLimiter('signup', HOUR, 10);

/** SQLSTATE-named unique indexes a sign-up can collide with. */
const USERNAME_UNIQUE_CONSTRAINT = 'users_lower_username_key';
const EMAIL_UNIQUE_CONSTRAINT = 'users_lower_email_key';

function envelopeOf(body: { deviceName?: string; deviceFingerprint?: string; device?: { deviceId: string; deviceSecret: string } }) {
  return {
    ...(body.deviceName ? { deviceName: body.deviceName } : {}),
    ...(body.deviceFingerprint ? { deviceFingerprint: body.deviceFingerprint } : {}),
    ...(body.device ? { device: body.device } : {}),
  };
}

router.post(
  '/signin/email/start',
  requireOfficialOrigin,
  startLimiter,
  validate({ body: emailSignInStartRequestSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(200).json(await startEmailSignIn(req.body as EmailSignInStartRequest, hashedIpKey(req)));
  }),
);

router.post(
  '/signin/email/confirm',
  requireOfficialOrigin,
  confirmLimiter,
  validate({ body: emailSignInConfirmRequestSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as EmailSignInConfirmRequest;
    const userId = await confirmEmailSignIn(body);
    res.status(200).json(await completeFirstFactor(req, userId, envelopeOf(body)));
  }),
);

router.post(
  '/signin/email/link',
  requireAuthWebOrigin,
  linkLimiter,
  validate({ body: emailSignInLinkRequestSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    await approveEmailSignInLink(req.body as EmailSignInLinkRequest);
    res.status(200).json({ approved: true });
  }),
);

router.post(
  '/signin/email/collect',
  requireOfficialOrigin,
  collectLimiter,
  validate({ body: emailSignInCollectRequestSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as EmailSignInCollectRequest;
    const outcome = await collectEmailSignIn(body);
    if ('status' in outcome) {
      res.status(200).json(outcome);
      return;
    }
    res.status(200).json(await completeFirstFactor(req, outcome.userId, envelopeOf(body)));
  }),
);

function lockedOut(retryAfterSeconds?: number): ApiError {
  return new ApiError(
    429,
    'Too many wrong attempts. Try again later.',
    SIGN_IN_ERROR_CODES.locked,
    retryAfterSeconds ? { retryAfterSeconds } : undefined,
  );
}

/**
 * A personal, active account WITHOUT a Commons key the identifier names — the
 * only kind a password signs in. A Commons account signs in with Commons
 * (linking deleted its password); it is answered exactly like an unknown name.
 */
async function passwordAccount(identifier: string): Promise<string | null> {
  const trimmed = identifier.trim();
  const match = trimmed.includes('@')
    ? sql`lower(btrim(${users.email})) = lower(btrim(${trimmed}))`
    : sql`lower(btrim(${users.username})) = lower(btrim(${trimmed}))`;
  const [row] = await getDb()
    .select({ id: users.id, kind: users.kind, accountStatus: users.accountStatus, publicKey: users.publicKey })
    .from(users)
    .where(match)
    .limit(1);
  return row && row.kind === 'personal' && row.accountStatus === 'active' && !row.publicKey ? row.id : null;
}

router.post(
  '/signin/password',
  requireOfficialOrigin,
  passwordLimiter,
  validate({ body: passwordSignInRequestSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as PasswordSignInRequest;
    const userId = await passwordAccount(body.identifier);
    // Keyed by the identifier AS TYPED, whether or not it names an account,
    // so the lockout behaves identically for both and says nothing. The
    // attempt is reserved atomically BEFORE the check, so parallel guesses
    // share one budget. A locked identifier is answered before any hashing —
    // that depends only on the identifier's own count, never on whether an
    // account exists, and a flood of locked guesses costs no scrypt work.
    // Below the cap the same query and the same scrypt work run whether or
    // not there is an account or a password, so the time says nothing either.
    const key = identifierLockoutKey(body.identifier);
    const reservation = await reserveAttempt({ scope: PASSWORD_LOCKOUT_SCOPE, identifier: key });
    if (reservation.locked) throw lockedOut(reservation.retryAfterSeconds);
    const stored = await readPasswordHash(userId ?? '00000000-0000-0000-0000-000000000000');
    const ok = await verifyPasswordOrDummy(body.password, userId ? stored : null);
    if (!ok || !userId) {
      throw new ApiError(401, 'That username, email or password is not right.', SIGN_IN_ERROR_CODES.invalidCredentials);
    }
    await clearFailures({ scope: PASSWORD_LOCKOUT_SCOPE, identifier: key });
    res.status(200).json(await completeFirstFactor(req, userId, envelopeOf(body)));
  }),
);

router.post(
  '/signin/second-factor',
  requireOfficialOrigin,
  secondFactorLimiter,
  validate({ body: secondFactorSignInRequestSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as SecondFactorSignInRequest;
    res.status(200).json(await completeSecondFactor(req, { challengeId: body.challengeId, code: body.code, ...envelopeOf(body) }));
  }),
);

/**
 * A new account: the username, and the email its `signup` ticket confirmed.
 * No key, no passkey, no password — those are added later from the account's
 * settings. The ticket is spent in the transaction that creates the account,
 * so a failed creation leaves it usable.
 */
router.post(
  '/signup',
  requireOfficialOrigin,
  signupLimiter,
  validate({ body: signUpRequestSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as SignUpRequest;
    const username = normalizeUsername(body.username);
    if (!isValidUsername(username)) {
      throw new BadRequestError(USERNAME_INVALID_MESSAGE);
    }
    const db = getDb();
    const [taken] = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(btrim(${users.username})) = lower(btrim(${username}))`)
      .limit(1);
    if (taken) throw new ApiError(409, 'Username already taken', SIGN_IN_ERROR_CODES.usernameTaken);

    let account: { id: string; username: string | null; avatar: string | null };
    try {
      account = await db.transaction(async (tx) => {
        await spendSignupTicket(tx, body.emailTicket, body.email);
        const [created] = await tx
          .insert(users)
          .values({ username, email: body.email })
          .returning({ id: users.id, username: users.username, avatar: users.avatar });
        return created;
      });
    } catch (error) {
      if (isUniqueViolation(error, USERNAME_UNIQUE_CONSTRAINT)) {
        throw new ApiError(409, 'Username already taken', SIGN_IN_ERROR_CODES.usernameTaken);
      }
      if (isUniqueViolation(error, EMAIL_UNIQUE_CONSTRAINT)) {
        throw new ConflictError('This email already belongs to an account');
      }
      throw error;
    }

    try {
      await db.insert(notifications).values({
        recipientId: account.id,
        actorId: account.id,
        type: 'welcome',
        entityId: account.id,
        entityType: 'profile',
        read: false,
      });
    } catch (error) {
      logger.error('Failed to create welcome notification during sign-up', error instanceof Error ? error : new Error(String(error)), {
        component: 'signIn',
        userId: account.id,
      });
    }

    res.status(200).json(await mintSignInSession(req, account, envelopeOf(body)));
  }),
);

export default router;
