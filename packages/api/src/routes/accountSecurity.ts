/**
 * How the signed-in account signs in — its password and its authenticator —
 * mounted at `/users/me`:
 *
 *  - `GET  /sign-in-methods`     → `{ hasEmail, hasPassword, totpEnabled, backupCodesRemaining }`
 *  - `POST /reauth/email`        → `{ verificationId, expiresAt }`: a code to the account's email
 *  - `PUT  /password`            `{ newPassword, reauth, revokeOtherSessions? }` → `{ success }`
 *  - `POST /totp/enroll`         → `{ secret, otpauthUri }` (pending until confirmed)
 *  - `POST /totp/confirm`        `{ code, reauth }` → `{ backupCodes }`
 *  - `POST /totp/disable`        `{ reauth }` → `{ success }`
 *  - `POST /totp/backup-codes`   `{ reauth }` → `{ backupCodes }`
 *
 * Every change needs a FRESH proof in the same request (`reauth`: the current
 * password or a code just sent to the email, plus the authenticator code when
 * it is on — `services/reauth.service.ts`), is told to the account's email, and
 * turning the authenticator on or off signs every other session out (the
 * password: when asked). Official Oxy apps only, first-party bearers only, a
 * personal account only; limits per account.
 */
import { Router, type Response } from 'express';
import { eq } from 'drizzle-orm';
import {
  SIGN_IN_ERROR_CODES,
  passwordSetRequestSchema,
  totpConfirmRequestSchema,
  totpReauthRequestSchema,
  type PasswordSetRequest,
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
import { readPasswordHash, storePassword } from '../services/password.service';
import { startReauthEmail, verifyReauth } from '../services/reauth.service';
import sessionService from '../services/session.service';
import { confirmTotp, disableTotp, enrollTotp, isTotpEnabled, readTotpState, regenerateBackupCodes } from '../services/totp.service';
import { asyncHandler } from '../utils/asyncHandler';
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
      return userId ? `account:security:${name}:${userId}` : `account:security:${name}:ip:${hashedIpKey(req)}`;
    },
  });
}

const HOUR = 60 * 60 * 1000;
const readLimiter = accountLimiter('read', 15 * 60 * 1000, 120);
const reauthEmailLimiter = accountLimiter('reauth-email', HOUR, 10);
const changeLimiter = accountLimiter('change', HOUR, 30);

router.use(['/sign-in-methods', '/reauth', '/password', '/totp'], requireOfficialOrigin, authMiddleware, requireFirstPartyDeviceAccess);

interface Owner {
  userId: string;
  email: string | null;
  username: string | null;
}

/** The signed-in personal account. */
async function owner(req: AuthRequest): Promise<Owner> {
  const userId = req.user?.id;
  if (!userId) throw new UnauthorizedError('Authentication required');
  const [row] = await getDb()
    .select({ email: users.email, username: users.username, kind: users.kind })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) throw new NotFoundError('User not found');
  if (row.kind !== 'personal') throw new ForbiddenError('Only a personal account signs in with a password or an authenticator');
  return { userId, email: row.email?.trim().toLowerCase() || null, username: row.username };
}

function notify(account: Owner, notice: SecurityNotice): void {
  if (!account.email) return;
  sendSecurityNotice(account.email, notice, account.username).catch((error: unknown) => {
    logger.error('Security notice could not be sent', error instanceof Error ? error : new Error(String(error)), {
      component: 'accountSecurity',
      notice,
    });
  });
}

router.get(
  '/sign-in-methods',
  readLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const account = await owner(req);
    const [password, totp] = await Promise.all([readPasswordHash(account.userId), readTotpState(account.userId)]);
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
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const account = await owner(req);
    res.status(200).json(await startReauthEmail(account.userId));
  }),
);

router.put(
  '/password',
  changeLimiter,
  validate({ body: passwordSetRequestSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const account = await owner(req);
    const body = req.body as PasswordSetRequest;
    await verifyReauth(account.userId, body.reauth);
    const hadPassword = (await readPasswordHash(account.userId)) !== null;
    await storePassword(account.userId, body.newPassword);
    if (body.revokeOtherSessions) {
      await sessionService.deactivateAllUserSessions(account.userId, req.sessionId);
    }
    notify(account, hadPassword ? 'password_changed' : 'password_set');
    res.status(200).json({ success: true });
  }),
);

router.post(
  '/totp/enroll',
  changeLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const account = await owner(req);
    res.status(200).json(await enrollTotp(account.userId, account.username ?? account.userId));
  }),
);

router.post(
  '/totp/confirm',
  changeLimiter,
  validate({ body: totpConfirmRequestSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const account = await owner(req);
    const body = req.body as TotpConfirmRequest;
    // Not on yet, so the proof is the password or the email code alone.
    await verifyReauth(account.userId, body.reauth);
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
      throw new ApiError(400, 'This account has no authenticator', SIGN_IN_ERROR_CODES.totpNotEnabled);
    }
    await verifyReauth(account.userId, body.reauth);
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
    await verifyReauth(account.userId, body.reauth);
    const backupCodes = await regenerateBackupCodes(account.userId);
    notify(account, 'backup_codes_regenerated');
    res.status(200).json({ backupCodes });
  }),
);

export default router;
