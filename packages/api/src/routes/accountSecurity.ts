/**
 * How the signed-in account signs in — its email, its password and its
 * authenticator — mounted at `/users/me`:
 *
 *  - `GET  /sign-in-methods`     → `{ hasEmail, hasPassword, totpEnabled, backupCodesRemaining }`
 *  - `POST /reauth/email`        `{ action }` → `{ verificationId, expiresAt }`: a code to the
 *    account's email for that ONE change (`change_password`, `change_email`, `totp`, …)
 *  - `POST /email/verify/start`  `{ email }` → `{ verificationId, expiresAt }`: a code to the NEW address
 *  - `PUT  /email`               `{ email, verificationId, code, reauth }` → `{ success }`: add or change it
 *  - `DELETE /email`             `{ reauth }` → `{ success }`: only with a password, confirmed with it
 *  - `PUT  /password`            `{ newPassword, reauth, revokeOtherSessions? }` → `{ success }`
 *  - `DELETE /password`          `{ reauth }` → `{ success }`: only while the account has an email
 *  - `POST /totp/enroll`         → `{ secret, otpauthUri }` (pending until confirmed)
 *  - `POST /totp/confirm`        `{ code, reauth }` → `{ backupCodes }`
 *  - `POST /totp/disable`        `{ reauth }` → `{ success }`
 *  - `POST /totp/backup-codes`   `{ reauth }` → `{ backupCodes }`
 *
 * Every change needs a FRESH proof in the same request (`reauth`: the current
 * password or a code just sent to the email, plus the authenticator code when
 * it is on — `services/reauth.service.ts`), is told to the account's email, and
 * turning the authenticator on or off, removing the password and adding,
 * changing or removing the email sign every other session out (setting the
 * password: when asked). The account never loses its last way in: the email
 * goes only with a password set, the password only with an email. Official
 * Oxy apps only, first-party bearers only, a personal account only; limits
 * per account.
 */
import { Router, type Response } from 'express';
import { eq } from 'drizzle-orm';
import {
  SIGN_IN_ERROR_CODES,
  emailChangeStartRequestSchema,
  emailSetRequestSchema,
  passwordSetRequestSchema,
  reauthEmailStartRequestSchema,
  signInMethodRemoveRequestSchema,
  totpConfirmRequestSchema,
  totpReauthRequestSchema,
  type EmailChangeStartRequest,
  type EmailSetRequest,
  type PasswordSetRequest,
  type ReauthEmailStartRequest,
  type SignInMethodRemoveRequest,
  type SignInMethods,
  type TotpConfirmRequest,
  type TotpReauthRequest,
} from '@oxy.so/contracts';
import { getDb } from '../config/postgres';
import { users } from '../db/schema/users';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import { requireFirstPartyDeviceAccess } from '../middleware/firstPartyDeviceAccess';
import { requireOfficialOrigin } from '../middleware/officialOrigin';
import { rateLimit } from '../middleware/rateLimiter';
import { validate } from '../middleware/validate';
import { sendSecurityNotice, type SecurityNotice } from '../services/accountEmail.mail';
import { changeEmail, removeEmail, startEmailChange } from '../services/accountEmailChange.service';
import { readPasswordHash, removePassword, storePassword } from '../services/password.service';
import { startReauthEmail, verifyReauth } from '../services/reauth.service';
import sessionService from '../services/session.service';
import {
  confirmTotp,
  disableTotp,
  enrollTotp,
  isTotpEnabled,
  readTotpState,
  regenerateBackupCodes,
} from '../services/totp.service';
import { asyncHandler } from '../utils/asyncHandler';
import userCache from '../utils/userCache';
import { ApiError, ForbiddenError, NotFoundError, UnauthorizedError } from '../utils/error';
import { hashedIpKey } from '../utils/ipKey';
import { logger } from '../utils/logger';

const router = Router();

function accountLimiter(name: string, windowMs: number, max: number) {
  return rateLimit({
    prefix: `rl:account:security:${name}:`,
    windowMs,
    max,
    message: 'Too many attempts. Please try again later.',
    keyGenerator: (req): string => {
      const userId = (req as AuthRequest).user?.id;
      return userId
        ? `account:security:${name}:${userId}`
        : `account:security:${name}:ip:${hashedIpKey(req)}`;
    },
  });
}

const HOUR = 60 * 60 * 1000;
const readLimiter = accountLimiter('read', 15 * 60 * 1000, 120);
const reauthEmailLimiter = accountLimiter('reauth-email', HOUR, 10);
const changeLimiter = accountLimiter('change', HOUR, 30);

router.use(
  ['/sign-in-methods', '/reauth', '/email', '/password', '/totp'],
  requireOfficialOrigin,
  (_req, res, next) => {
    res.locals.supervisedSelfOperation = true;
    next();
  },
  authMiddleware,
  requireFirstPartyDeviceAccess,
);

interface Owner {
  userId: string;
  email: string | null;
  username: string | null;
}

/**
 * The signed-in personal account. `keyless`: a change that adds a way in
 * (a password, an authenticator) is refused for an account with a Commons
 * key — it signs in with Commons, and linking removed those factors.
 */
async function owner(req: AuthRequest, options: { keyless?: boolean } = {}): Promise<Owner> {
  const userId = req.user?.id;
  if (!userId) throw new UnauthorizedError('Authentication required');
  const [row] = await getDb()
    .select({
      email: users.email,
      username: users.username,
      kind: users.kind,
      publicKey: users.publicKey,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) throw new NotFoundError('User not found');
  if (row.kind !== 'personal')
    throw new ForbiddenError(
      'Only a personal account signs in with a password or an authenticator',
    );
  if (options.keyless && row.publicKey) {
    throw new ForbiddenError('This account signs in with Commons');
  }
  return { userId, email: row.email?.trim().toLowerCase() || null, username: row.username };
}

function notify(account: Owner, notice: SecurityNotice, to: string | null = account.email): void {
  if (!to) return;
  sendSecurityNotice(to, notice, account.username).catch((error: unknown) => {
    logger.error(
      'Security notice could not be sent',
      error instanceof Error ? error : new Error(String(error)),
      {
        component: 'accountSecurity',
        notice,
      },
    );
  });
}

router.get(
  '/sign-in-methods',
  readLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const account = await owner(req);
    const [password, totp] = await Promise.all([
      readPasswordHash(account.userId),
      readTotpState(account.userId),
    ]);
    const methods: SignInMethods = {
      hasEmail: account.email !== null,
      hasPassword: password !== null,
      totpEnabled: totp.enabled,
      backupCodesRemaining: totp.backupCodesRemaining,
    };
    res.status(200).json(methods);
  }),
);

router.post(
  '/reauth/email',
  reauthEmailLimiter,
  validate({ body: reauthEmailStartRequestSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const account = await owner(req);
    const { action } = req.body as ReauthEmailStartRequest;
    res.status(200).json(await startReauthEmail(account.userId, action));
  }),
);

router.put(
  '/password',
  changeLimiter,
  validate({ body: passwordSetRequestSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const account = await owner(req, { keyless: true });
    const body = req.body as PasswordSetRequest;
    await verifyReauth(account.userId, body.reauth, 'change_password');
    const hadPassword = (await readPasswordHash(account.userId)) !== null;
    await storePassword(account.userId, body.newPassword);
    if (body.revokeOtherSessions) {
      await sessionService.deactivateAllUserSessions(account.userId, req.sessionId);
    }
    notify(account, hadPassword ? 'password_changed' : 'password_set');
    res.status(200).json({ success: true });
  }),
);

router.delete(
  '/password',
  changeLimiter,
  validate({ body: signInMethodRemoveRequestSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const account = await owner(req, { keyless: true });
    const body = req.body as SignInMethodRemoveRequest;
    if (!account.email) {
      throw new ApiError(
        400,
        'Add an email before removing the password.',
        SIGN_IN_ERROR_CODES.lastSignInMethod,
      );
    }
    await verifyReauth(account.userId, body.reauth, 'change_password');
    await removePassword(account.userId);
    await sessionService.deactivateAllUserSessions(account.userId, req.sessionId);
    notify(account, 'password_removed');
    res.status(200).json({ success: true });
  }),
);

router.post(
  '/email/verify/start',
  reauthEmailLimiter,
  validate({ body: emailChangeStartRequestSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const account = await owner(req, { keyless: true });
    const { email } = req.body as EmailChangeStartRequest;
    res.status(200).json(await startEmailChange(account, email));
  }),
);

router.put(
  '/email',
  changeLimiter,
  validate({ body: emailSetRequestSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const account = await owner(req, { keyless: true });
    const body = req.body as EmailSetRequest;
    await changeEmail(account, body);
    userCache.invalidate(account.userId);
    await sessionService.deactivateAllUserSessions(account.userId, req.sessionId);
    if (account.email) notify(account, 'email_changed');
    notify(account, 'email_added', body.email);
    res.status(200).json({ success: true });
  }),
);

router.delete(
  '/email',
  changeLimiter,
  validate({ body: signInMethodRemoveRequestSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const account = await owner(req, { keyless: true });
    const body = req.body as SignInMethodRemoveRequest;
    await removeEmail(account, body.reauth);
    userCache.invalidate(account.userId);
    await sessionService.deactivateAllUserSessions(account.userId, req.sessionId);
    notify(account, 'email_removed');
    res.status(200).json({ success: true });
  }),
);

router.post(
  '/totp/enroll',
  changeLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const account = await owner(req, { keyless: true });
    res.status(200).json(await enrollTotp(account.userId, account.username ?? account.userId));
  }),
);

router.post(
  '/totp/confirm',
  changeLimiter,
  validate({ body: totpConfirmRequestSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const account = await owner(req, { keyless: true });
    const body = req.body as TotpConfirmRequest;
    // Not on yet, so the proof is the password or the email code alone.
    await verifyReauth(account.userId, body.reauth, 'totp');
    const backupCodes = await confirmTotp(account.userId, body.code);
    await sessionService.deactivateAllUserSessions(account.userId, req.sessionId);
    notify(account, 'totp_enabled');
    res.status(200).json({ backupCodes });
  }),
);

router.post(
  '/totp/disable',
  changeLimiter,
  validate({ body: totpReauthRequestSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const account = await owner(req);
    const body = req.body as TotpReauthRequest;
    if (!(await isTotpEnabled(account.userId))) {
      throw new ApiError(
        400,
        'This account has no authenticator',
        SIGN_IN_ERROR_CODES.totpNotEnabled,
      );
    }
    await verifyReauth(account.userId, body.reauth, 'totp');
    await disableTotp(account.userId);
    await sessionService.deactivateAllUserSessions(account.userId, req.sessionId);
    notify(account, 'totp_disabled');
    res.status(200).json({ success: true });
  }),
);

router.post(
  '/totp/backup-codes',
  changeLimiter,
  validate({ body: totpReauthRequestSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const account = await owner(req);
    const body = req.body as TotpReauthRequest;
    await verifyReauth(account.userId, body.reauth, 'totp');
    const backupCodes = await regenerateBackupCodes(account.userId);
    notify(account, 'backup_codes_regenerated');
    res.status(200).json({ backupCodes });
  }),
);

export default router;
