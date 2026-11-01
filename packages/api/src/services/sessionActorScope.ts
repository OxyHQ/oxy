import { and, eq, isNull, or } from 'drizzle-orm';
import { sessions } from '../db/schema/sessions';

/** Match the subject and the principal represented by a session row. */
export function sessionActorScope(subjectId: string, principalId: string) {
  if (!subjectId || !principalId) throw new Error('Session actor scope is required');
  return and(
    eq(sessions.userId, subjectId),
    principalId === subjectId
      ? or(isNull(sessions.operatedByUserId), eq(sessions.operatedByUserId, principalId))
      : eq(sessions.operatedByUserId, principalId),
  );
}
