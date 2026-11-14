/** Account-bound internal resource operations, without manufacturing a user session. */
import type { Request, Response, NextFunction } from 'express';
import type { NamedRouteParams } from '../types/routeParams';
import {
  authMiddleware,
  serviceAuthMiddleware,
  type ServiceAuthRequest,
  type AuthRequest,
} from './auth';
import { verifyServiceToken } from './serviceToken';
import { firstPartyRequesterFor } from './firstPartyRequester';
import type { OxyPlatformReceiver } from '../utils/firstPartyDelegation';
import { ForbiddenError } from '../utils/error';

/** The person's own session, or the account an Oxy service acts for (ADR 0066). */
export function authenticatedRequesterAccountId(request: Request): string | undefined {
  const req = request as ServiceAuthRequest;
  if (req.serviceApp) return req.serviceActingFor?.subjectAccountId;
  const user = (request as AuthRequest).user;
  return user?.id ?? user?._id;
}

/**
 * A person in a session, or an Oxy service acting for one on `area`. A service
 * token that names no account it may act for is refused here (403).
 */
export function requesterAuthMiddleware(area: OxyPlatformReceiver) {
  return async (req: Request<NamedRouteParams>, res: Response, next: NextFunction) => {
    const token = req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : undefined;
    if (!token || !verifyServiceToken(token).ok) return authMiddleware(req, res, next);
    const service = req as ServiceAuthRequest;
    return serviceAuthMiddleware(service, res, (error?: unknown) => {
      if (error) return next(error);
      const effect = ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? 'read' : 'write';
      firstPartyRequesterFor(service, area, effect).then(
        (accounts) => {
          service.serviceActingFor = accounts;
          if (!accounts) {
            res.status(403).json({ error: 'verified_requester_required' });
            return;
          }
          next();
        },
        (refusal: unknown) => {
          if (refusal instanceof ForbiddenError) {
            res
              .status(403)
              .json({ error: 'verified_requester_required', message: refusal.message });
            return;
          }
          next(refusal);
        },
      );
    });
  };
}
