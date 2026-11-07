/**
 * The audit trail of the identity backup's two writes (`POST` and
 * `DELETE /identity/backup`).
 *
 * The backup is the only off-device copy of the person's retired keys, so who
 * replaced or removed it, and through which session, must be answerable after
 * the fact. Mounted after `authMiddleware` and BEFORE
 * `requireFirstPartyDeviceAccess`, so a refused attempt (a third-party or
 * application bearer, 403) is on the record too, not only the writes.
 *
 * Two records, neither of them carrying a secret: no lookup id, ciphertext,
 * nonce, key hint, bearer or IP.
 *
 *  - every attempt: one structured log line, `identity.backup.write`, with the
 *    action, the answer's status, the account, a prefix of the session id and
 *    the application the bearer belongs to (NULL: the shared session);
 *  - every write that succeeded: a security activity on the account's own trail
 *    (`GET /security/activity`), so the person sees it too. An upload is a
 *    `backup_created`, a deletion a `security_settings_changed` on
 *    `identity_backup`; both `high`.
 *
 * Recorded once the answer is sent and never able to change it: a failure to
 * record is logged and swallowed, like every security-activity write.
 */

import type { NextFunction, Response } from 'express';
import securityActivityService from '../services/securityActivityService';
import { logger } from '../utils/logger';
import type { AuthRequest } from './auth';

/** Which of the two writes a request is. */
export type IdentityBackupWrite = 'upload' | 'delete';

/** How an attempt ended, from its HTTP status. */
export type IdentityBackupWriteOutcome = 'written' | 'refused' | 'failed' | 'unanswered';

/**
 * The outcome an answer's status means. `unanswered`: the connection closed
 * before the answer was sent, so its status says nothing (it may still read 200).
 */
export function identityBackupWriteOutcome(
  status: number,
  answered = true,
): IdentityBackupWriteOutcome {
  if (!answered) return 'unanswered';
  if (status >= 200 && status < 300) return 'written';
  if (status === 401 || status === 403) return 'refused';
  return 'failed';
}

/** Record one attempt: the log line always, the account's trail on success. */
export async function recordIdentityBackupWrite(
  action: IdentityBackupWrite,
  req: AuthRequest,
  status: number,
  answered = true,
): Promise<void> {
  const userId = req.user?._id ? String(req.user._id) : undefined;
  const token = req.oxyToken;
  const outcome = identityBackupWriteOutcome(status, answered);
  const fields = {
    action,
    status,
    outcome,
    userId,
    sessionId: token?.sessionId ? `${token.sessionId.substring(0, 8)}...` : undefined,
    applicationId: token?.applicationId ?? null,
    ...(token?.host ? { hostApplicationId: token.host.applicationId } : {}),
    ...(token && token.principalUserId !== token.subjectAccountId
      ? { operatedByUserId: token.principalUserId }
      : {}),
  };
  if (outcome === 'written') {
    logger.info('identity.backup.write', fields);
  } else {
    logger.warn('identity.backup.write', fields);
  }

  if (outcome !== 'written' || !userId) return;
  try {
    await securityActivityService.logSecurityEvent(
      action === 'upload'
        ? {
            userId,
            eventType: 'backup_created',
            eventDescription: 'Identity backup saved',
            metadata: { backupType: 'identity_backup' },
            req,
            severity: 'high',
          }
        : {
            userId,
            eventType: 'security_settings_changed',
            eventDescription: 'Identity backup deleted',
            metadata: { settingName: 'identity_backup', oldValue: 'present', newValue: 'deleted' },
            req,
            severity: 'high',
          },
    );
  } catch (error) {
    logger.warn('identity.backup.write: security activity not recorded', {
      action,
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Audit `action` for this route once its answer is sent. `close` fires for an
 * answered request and for one the client abandoned, so no attempt that reached
 * the handler goes unrecorded.
 */
export function auditIdentityBackupWrite(action: IdentityBackupWrite) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    res.once('close', () => {
      void recordIdentityBackupWrite(action, req, res.statusCode, res.writableFinished);
    });
    next();
  };
}
