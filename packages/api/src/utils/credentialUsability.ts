import type { ApplicationCredentialStatus } from '../db/schema/applicationCredentials';

/**
 * Predicate: may this credential currently be used to authenticate?
 *
 * A credential is usable when:
 *  - it is `active` and has no `expiresAt` or a future `expiresAt`; OR
 *  - it is `deprecated` and has a future `expiresAt` (rotation grace window).
 *
 * `revoked` credentials are NEVER usable. `deprecated` credentials MUST have
 * an explicit future grace `expiresAt` (set during rotation); a deprecated
 * credential without an expiry is treated as disabled. This is the
 * single source of truth shared by every credential-resolution site (OAuth
 * authorize/token, service-token mint) — do not duplicate the predicate.
 *
 * Pure — it reads two fields and a clock, so it is trivially unit-testable and
 * callable with any row shape carrying them.
 */
export function isCredentialUsable(
  credential: { status: ApplicationCredentialStatus; expiresAt?: Date | null }
): boolean {
  if (credential.status === 'revoked') {
    return false;
  }
  if (credential.status === 'active') {
    return !credential.expiresAt || credential.expiresAt.getTime() > Date.now();
  }
  if (credential.status === 'deprecated') {
    return Boolean(credential.expiresAt && credential.expiresAt.getTime() > Date.now());
  }
  return false;
}
