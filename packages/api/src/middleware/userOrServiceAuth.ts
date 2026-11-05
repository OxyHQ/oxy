import type { Response, NextFunction } from 'express';
import {
  authMiddleware,
  serviceAuthMiddleware,
  type AuthRequest,
  type ServiceAuthRequest,
} from './auth';
import { verifyServiceToken } from './serviceToken';

/** Select a lane; the selected shared middleware owns all live authority checks. */
export function userOrServiceAuthMiddleware(
  req: AuthRequest & ServiceAuthRequest,
  res: Response,
  next: NextFunction,
): void {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ') && verifyServiceToken(header.slice(7)).ok) {
    void serviceAuthMiddleware(req, res, next);
    return;
  }
  void authMiddleware(req, res, next);
}
