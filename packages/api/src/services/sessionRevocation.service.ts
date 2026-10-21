/**
 * THE place a session stops being valid.
 *
 * Every write that ends a session — `sessions.is_active` → false — is
 * {@link deactivateSessionRows}, and every one is followed, once it committed,
 * by an announcement: {@link announceSessionRevocations} for the rows it ended,
 * {@link announceUserSessionsRevoked} when a whole account's sessions end
 * (sign-out everywhere, deletion, archive). The announcement drops the session
 * from `sessionCache` here, from every other oxy-api task's in-memory tier, and
 * from every Oxy backend's validation cache (`utils/serviceEvents.ts`).
 *
 * Inside a caller's transaction, deactivate with the transaction and announce
 * AFTER it commits: announcing first lets a backend re-ask Oxy, read the
 * still-active row and re-cache it. Announcing a write that then rolls back
 * costs nothing but one re-validation.
 *
 * `services/__tests__/sessionRevocation.census.test.ts` fails the build on a
 * writer to `sessions` (or a deleter of `users`) that does not go through here,
 * until somebody decides how it announces.
 */
import { and, eq, type SQL } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../config/postgres';
import { sessions } from '../db/schema/sessions';
import sessionCache from '../utils/sessionCache';
import { publishSessionRevocation } from '../utils/serviceEvents';

/** One session a deactivation ended: its public id and the account it spoke as. */
export interface RevokedSession {
  sessionId: string;
  userId: string;
}

/**
 * End every ACTIVE session matching `where`, and return exactly the rows this
 * write ended. Pass them to {@link announceSessionRevocations} once the write
 * committed (at once, unless `executor` is a transaction).
 *
 * Never deletes: only the expiry sweep removes a row (see the schema). An
 * unscoped call (`where` undefined, e.g. an `and()` of nothing) is refused: it
 * would sign out every account on the platform.
 */
export async function deactivateSessionRows(
  executor: DatabaseOrTransaction,
  where: SQL | undefined,
): Promise<RevokedSession[]> {
  if (!where) throw new Error('Refusing to deactivate sessions without a scope');
  return executor
    .update(sessions)
    .set({ isActive: false })
    .where(and(eq(sessions.isActive, true), where))
    .returning({ sessionId: sessions.sessionId, userId: sessions.userId });
}

/** {@link deactivateSessionRows} outside any transaction, announced. */
export async function revokeSessions(where: SQL | undefined): Promise<RevokedSession[]> {
  const revoked = await deactivateSessionRows(getDb(), where);
  announceSessionRevocations(revoked);
  return revoked;
}

/** Tell every cache that these sessions ended. Never throws. */
export function announceSessionRevocations(revoked: readonly RevokedSession[]): void {
  const at = Date.now();
  for (const { sessionId, userId } of revoked) {
    sessionCache.invalidate(sessionId);
    publishSessionRevocation({ sessionId, userId, at });
  }
}

/**
 * Tell every cache that every session of `userId` ended (or may have: the
 * account was deleted or archived, or signed out everywhere). Never throws.
 */
export function announceUserSessionsRevoked(userId: string): void {
  sessionCache.invalidateUserSessions(userId);
  publishSessionRevocation({ userId, at: Date.now() });
}
