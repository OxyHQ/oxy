/** Authenticate Kaana's live workload before any private control operation. */
import type { NextFunction, Request, Response } from 'express';
import {
  KAANA_CONTROL_APPLICATION_ID,
  KAANA_CONTROL_AUDIENCE,
} from '../config/serviceTokenAudiences';
import { extractTokenFromRequest } from './authUtils';
import { verifyServiceToken } from './serviceToken';
import { resolveServiceTokenPrincipal } from '../services/attribution.service';
import { logger } from '../utils/logger';

export async function requireKaanaWorkload(
  req: Request,
  res: Response,
  next: NextFunction,
  options: { workloadOnly?: boolean } = {},
): Promise<void> {
  const token = extractTokenFromRequest(req);
  const verification =
    token === null || token === undefined
      ? undefined
      : verifyServiceToken(token, KAANA_CONTROL_AUDIENCE);
  if (verification === undefined || !verification.ok) {
    res.status(401).json({ error: 'kaana_workload_required' });
    return;
  }
  if (verification.payload.appId !== KAANA_CONTROL_APPLICATION_ID) {
    logger.warn('inference.kaana_control.foreign_application', {
      applicationId: verification.payload.appId,
    });
    res.status(403).json({ error: 'kaana_workload_required' });
    return;
  }
  // The row, not the token: a revoked credential or binding stops within the hour it was minted for.
  const resolution = await resolveServiceTokenPrincipal(verification.payload);
  if (resolution.status !== 'resolved') {
    logger.warn('inference.kaana_control.principal_unresolved', { status: resolution.status });
    res.status(403).json({ error: 'kaana_workload_required' });
    return;
  }
  // The application comes from the ROW the token names, never from its claim.
  if (resolution.principal.applicationId !== KAANA_CONTROL_APPLICATION_ID) {
    logger.warn('inference.kaana_control.foreign_application', {
      applicationId: resolution.principal.applicationId,
    });
    res.status(403).json({ error: 'kaana_workload_required' });
    return;
  }
  if (
    options.workloadOnly &&
    (resolution.principal.proof !== 'workload' || resolution.principal.authority !== 'first_party')
  ) {
    res.status(403).json({ error: 'kaana_workload_required' });
    return;
  }
  next();
}
