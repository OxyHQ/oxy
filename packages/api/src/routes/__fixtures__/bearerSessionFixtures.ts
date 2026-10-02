/**
 * A real `sessions` row for a suite that stubs `authMiddleware`.
 *
 * The real middleware only ever admits a bearer whose session row it just
 * validated, and sets `req.sessionId` to it. Routes read that row — e.g.
 * `resolveApprovalOperator` reads who operates the approving session — so a stub
 * that hands out `req.user` must hand out a session that exists too, or the
 * route sees a bearer production can never produce.
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '../../config/postgres';
import { sessions } from '../../db/schema/sessions';

/** Insert an active session for `userId` (operated by `operatedByUserId` when given); returns its `sessionId`. */
export async function insertBearerSession(
  userId: string,
  operatedByUserId: string | null = null,
): Promise<string> {
  const sessionId = randomUUID();
  await getDb().insert(sessions).values({
    sessionId,
    userId,
    deviceId: `dev-${randomUUID()}`,
    deviceType: 'desktop',
    platform: 'unknown',
    accessToken: `stub-access-${randomUUID()}`,
    refreshToken: `stub-refresh-${randomUUID()}`,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    operatedByUserId,
  });
  return sessionId;
}
