/**
 * Decoded access-token claims, memoised per token string.
 *
 * Every request used to decode the same JWT several times (the auth preflight,
 * the cache key, the dedupe key, the expiry checks). A token is immutable, so
 * its claims are decoded once and reused until a new token replaces it. The
 * memo holds a handful of recent tokens (a client, its linked clients, a
 * rotation in flight) and never the payload of a token no longer in use.
 */
import { jwtDecode } from 'jwt-decode';

export interface AccessTokenClaims {
  exp?: number;
  userId?: string;
  id?: string;
  sessionId?: string;
  [claim: string]: unknown;
}

const MEMO_SIZE = 4;
const memo = new Map<string, AccessTokenClaims | null>();

/** The token's claims, or `null` for an opaque/undecodable token. */
export function decodeTokenClaims(token: string): AccessTokenClaims | null {
  if (memo.has(token)) return memo.get(token) ?? null;
  let claims: AccessTokenClaims | null;
  try {
    claims = jwtDecode<AccessTokenClaims>(token);
  } catch {
    claims = null;
  }
  memo.set(token, claims);
  if (memo.size > MEMO_SIZE) {
    const oldest = memo.keys().next().value;
    if (oldest !== undefined) memo.delete(oldest);
  }
  return claims;
}
