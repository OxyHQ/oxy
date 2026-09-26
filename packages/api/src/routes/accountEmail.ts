/**
 * Recovery email verification (ADR 0029 D3), mounted at `/auth/email`:
 *
 *  - `POST /verify/start`    send a 6-digit code (`signup`: to the new
 *    account's email; `recovery`: to the recovery email of the account a
 *    username or email names) → `{ verificationId, expiresAt }`
 *  - `POST /verify/confirm`  the code → a one-use ticket, spent by
 *    `POST /auth/webauthn/register/*`
 *
 * No bearer: the person is signing up or has lost their passkey. Browser
 * requests are accepted only from auth.oxy.so (and loopback), where accounts
 * are created and recovered. Rate limits are keyed by the hashed IP
 * (`hashedIpKey`), and the service limits sends per hashed email. Neither
 * route says whether an account exists (see `accountEmail.service.ts`).
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  emailVerificationConfirmRequestSchema,
  emailVerificationStartRequestSchema,
  type EmailVerificationConfirmRequest,
  type EmailVerificationStartRequest,
} from '@oxy.so/contracts';
import { rateLimit } from '../middleware/rateLimiter';
import { validate } from '../middleware/validate';
import { confirmEmailVerification, startEmailVerification } from '../services/accountEmail.service';
import { asyncHandler } from '../utils/asyncHandler';
import { ForbiddenError } from '../utils/error';
import { hashedIpKey } from '../utils/ipKey';
import { isAuthWebOrigin } from '../utils/origin';

const router = Router();

function ipLimiter(name: string, max: number) {
  return rateLimit({
    prefix: `rl:auth:email:${name}:`,
    windowMs: 60 * 60 * 1000,
    max,
    message: 'Too many attempts. Please try again later.',
    keyGenerator: (req: Request): string => `auth:email:${name}:ip:${hashedIpKey(req)}`,
  });
}

const startLimiter = ipLimiter('start', 20);
const confirmLimiter = ipLimiter('confirm', 60);

function requireAuthWebOrigin(req: Request, _res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !isAuthWebOrigin(origin)) {
    next(new ForbiddenError('This endpoint is only available to auth.oxy.so'));
    return;
  }
  next();
}

router.use(requireAuthWebOrigin);

router.post(
  '/verify/start',
  startLimiter,
  validate({ body: emailVerificationStartRequestSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(200).json(await startEmailVerification(req.body as EmailVerificationStartRequest));
  }),
);

router.post(
  '/verify/confirm',
  confirmLimiter,
  validate({ body: emailVerificationConfirmRequestSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { verificationId, code } = req.body as EmailVerificationConfirmRequest;
    res.status(200).json(await confirmEmailVerification(verificationId, code));
  }),
);

export default router;
