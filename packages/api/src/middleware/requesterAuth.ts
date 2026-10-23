/** Account-bound internal resource operations, without manufacturing a user session. */
import type { Request, Response, NextFunction } from 'express';
import {
  authMiddleware,
  serviceAuthMiddleware,
  type ServiceAuthRequest,
  type AuthRequest,
} from './auth';
import { verifyServiceToken } from './serviceToken';

export function authenticatedRequesterAccountId(request: Request): string | undefined {
  const req = request as ServiceAuthRequest;
  if (req.serviceApp)
    return req.serviceApp.authority === 'first_party'
      ? req.serviceRequester?.subjectAccountId
      : undefined;
  const user = (request as AuthRequest).user;
  return user?.id ?? user?._id;
}

export async function requesterAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : undefined;
  if (token && verifyServiceToken(token).ok) {
    return serviceAuthMiddleware(req as ServiceAuthRequest, res, (error?: unknown) => {
      if (error) return next(error);
      if (!authenticatedRequesterAccountId(req)) {
        res.status(403).json({ error: 'verified_requester_required' });
        return;
      }
      next();
    });
  }
  return authMiddleware(req, res, next);
}
