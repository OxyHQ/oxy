/**
 * OAuth2 Authorization Code Service
 *
 * Pure logic for minting and exchanging OAuth2 authorization codes with
 * PKCE — extracted from the route handler so it can be tested in isolation
 * without spinning up Express.
 *
 * Lifecycle of a code:
 *   1. `issueAuthCode(...)` mints a random 256-bit code, stores its SHA-256
 *      hash (never the raw value) bound to user / app / redirectUri and
 *      optional PKCE challenge.
 *   2. `exchangeAuthCode(...)` looks the code up by hash, verifies all
 *      bindings, claims the code single-use via one atomic conditional
 *      `update ... where used_at is null`, and returns the resolved user id.
 *
 * All credential equality checks use `crypto.timingSafeEqual` to
 * eliminate timing leaks on code-binding mismatches.
 *
 * ## The single-use claim survived the port unchanged in SEMANTICS
 *
 * Mongo enforced it with `findOneAndUpdate({_id, usedAt: null}, …)`. Postgres
 * enforces it with `update … where id = $1 and used_at is null … returning`,
 * which is the same guarantee for the same reason: the predicate is evaluated
 * against the row the statement is about to write, under a row lock, so two
 * concurrent exchanges cannot both match. `returning` is what tells the loser
 * it lost — an empty array, exactly as Mongo's `null` did.
 *
 * ## Expiry is filtered on the READ path, not left to the sweep
 *
 * `auth_codes` is registered in `db/expiry.ts` with a 300s retention pad so a
 * just-expired code is still recognised as a REPLAY rather than answering "no
 * such code". That pad is only safe because the expiry comparison below is
 * still done here (class (A) in `schema/CONVENTIONS.md`); deleting it and
 * trusting the sweep would turn the pad into a five-minute window in which an
 * expired code still works.
 */

import * as crypto from 'crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { authCodes } from '../db/schema/authCodes';
import type { SelectedRow } from '@oxyhq/db';

export const AUTH_CODE_TTL_MS = 60 * 1000;
export const AUTH_CODE_BYTES = 32;

export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function timingSafeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

/** Collapse `https://app.example/` → `https://app.example` for OAuth binding. */
export function canonicalizeOAuthRedirectUri(redirectUri: string): string {
  try {
    const parsed = new URL(redirectUri);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return redirectUri;
    }
    if (parsed.pathname === '/' && !parsed.search && !parsed.hash) {
      return parsed.origin;
    }
    return redirectUri;
  } catch {
    return redirectUri;
  }
}

export interface IssueCodeOptions {
  /** The SUBJECT of the grant — the account the code authorizes access to. */
  userId: string;
  /**
   * The `applications.id` the code is issued TO.
   *
   * The OPTION keeps the name `appId` because that is what every caller and the
   * service-token JWT claim call it; the COLUMN is `application_id`, so that
   * every reference to `applications` in the schema carries one name. The
   * rename stops at this boundary deliberately.
   */
  appId: string;
  redirectUri: string;
  codeChallenge?: string;
  codeChallengeMethod?: 'S256';
  scopes?: string[];
  /** DeviceSession id from the authorizing bearer JWT. */
  deviceId?: string;
  /**
   * The OPERATOR identity when `userId` is a DELEGATED account (the identity
   * approved the app to act as that account). Kept separate from `userId` so the
   * two are never conflated: the session minted at exchange time is a managed
   * session bound to this operator's `account:act_as` membership.
   */
  operatedByUserId?: string;
  /**
   * Pre-allocated primary key for the code row. Lets a caller RESERVE the
   * code's identity inside an atomic single-use claim (see the OAuth-bound
   * AuthSession finalization) before anything is minted, so a spent request can
   * never mint a second code.
   */
  codeId?: string;
  ttlMs?: number;
}

export interface IssueCodeResult {
  code: string;
  expiresAt: Date;
}

export async function issueAuthCode(options: IssueCodeOptions): Promise<IssueCodeResult> {
  const ttlMs = options.ttlMs ?? AUTH_CODE_TTL_MS;
  const rawCode = base64UrlEncode(crypto.randomBytes(AUTH_CODE_BYTES));
  const codeHash = sha256Hex(rawCode);
  const expiresAt = new Date(Date.now() + ttlMs);

  await getDb()
    .insert(authCodes)
    .values({
      // Omitted when the caller reserved none, so the column's own
      // `generatedId()` default mints it.
      ...(options.codeId ? { id: options.codeId } : {}),
      codeHash,
      userId: options.userId,
      applicationId: options.appId,
      redirectUri: canonicalizeOAuthRedirectUri(options.redirectUri),
      // NULL, never `''`: `auth_codes_pkce_pair_check` asserts that challenge
      // and method are both present or both absent, and an empty string is a
      // VALUE that would satisfy "present" while verifying nothing.
      codeChallenge: options.codeChallenge ?? null,
      codeChallengeMethod: options.codeChallenge ? 'S256' : null,
      scopes: options.scopes ?? [],
      deviceId: options.deviceId ?? null,
      operatedByUserId: options.operatedByUserId ?? null,
      expiresAt,
    });

  return { code: rawCode, expiresAt };
}

export type ExchangeOutcome =
  | { ok: true; code: ExchangedAuthCode }
  | { ok: false; reason: 'invalid_grant' | 'invalid_client' };

export interface ExchangeCodeOptions {
  rawCode: string;
  appId: string;
  redirectUri: string;
  /** Confidential clients pass `clientSecret`. Verified outside this fn. */
  clientSecretProvided?: boolean;
  /** Public clients pass `codeVerifier`. */
  codeVerifier?: string;
}

/**
 * Every column of a stored code this exchange reads or returns.
 *
 * `code_hash` is deliberately absent: the caller already holds the raw code, so
 * handing back its verifier would only widen what a logged/serialised outcome
 * could leak.
 */
const EXCHANGE_COLUMNS = {
  id: authCodes.id,
  userId: authCodes.userId,
  applicationId: authCodes.applicationId,
  redirectUri: authCodes.redirectUri,
  codeChallenge: authCodes.codeChallenge,
  scopes: authCodes.scopes,
  deviceId: authCodes.deviceId,
  operatedByUserId: authCodes.operatedByUserId,
  usedAt: authCodes.usedAt,
  expiresAt: authCodes.expiresAt,
} as const;

/**
 * A redeemed code, as the token endpoint reads it.
 *
 * DERIVED from {@link EXCHANGE_COLUMNS} rather than written out, so adding or
 * removing a column cannot leave this type behind — the failure that shape
 * prevents is a serialiser reading a field the select never asked for.
 */
export type ExchangedAuthCode = SelectedRow<typeof EXCHANGE_COLUMNS>;

/**
 * Verify a redeemed code against its issuance bindings. Single-use is
 * enforced via one atomic conditional `update ... where used_at is null` —
 * two concurrent exchanges cannot both succeed.
 *
 * This function does NOT check the client secret itself (that's the
 * caller's responsibility — they have the credential's `secretHash` in scope).
 * It only verifies that EITHER a secret was supplied (confidential client)
 * OR the PKCE verifier matches the stored challenge.
 */
export async function exchangeAuthCode(options: ExchangeCodeOptions): Promise<ExchangeOutcome> {
  const codeHash = sha256Hex(options.rawCode);
  const db = getDb();
  const [stored] = await db
    .select(EXCHANGE_COLUMNS)
    .from(authCodes)
    .where(eq(authCodes.codeHash, codeHash))
    .limit(1);

  if (!stored) {
    return { ok: false, reason: 'invalid_grant' };
  }

  if (stored.usedAt) {
    // Replay of an already-redeemed code. RFC 6749 §10.5 RECOMMENDS the
    // server revoke any tokens previously issued from this code; that
    // responsibility lives with the route handler since it has access
    // to the session it minted.
    return { ok: false, reason: 'invalid_grant' };
  }

  if (stored.expiresAt < new Date()) {
    return { ok: false, reason: 'invalid_grant' };
  }

  if (stored.applicationId !== options.appId) {
    return { ok: false, reason: 'invalid_grant' };
  }

  if (
    !timingSafeStringEqual(
      canonicalizeOAuthRedirectUri(stored.redirectUri),
      canonicalizeOAuthRedirectUri(options.redirectUri),
    )
  ) {
    return { ok: false, reason: 'invalid_grant' };
  }

  if (stored.codeChallenge) {
    if (!options.codeVerifier) {
      return { ok: false, reason: 'invalid_grant' };
    }
    const computed = base64UrlEncode(
      crypto.createHash('sha256').update(options.codeVerifier).digest()
    );
    if (!timingSafeStringEqual(stored.codeChallenge, computed)) {
      return { ok: false, reason: 'invalid_grant' };
    }
  } else if (!options.clientSecretProvided) {
    // No PKCE was bound at issuance time AND the caller didn't present a
    // confidential client secret — refuse the exchange.
    return { ok: false, reason: 'invalid_client' };
  }

  // Atomic single-use claim — if a concurrent request races us, only the first
  // transitions `used_at` off NULL. The loser's `where` matches no row and
  // `returning` hands it an empty array, which is the same signal Mongo's
  // `null` was.
  const now = new Date();
  const [claimed] = await db
    .update(authCodes)
    .set({ usedAt: now })
    .where(and(eq(authCodes.id, stored.id), isNull(authCodes.usedAt)))
    .returning(EXCHANGE_COLUMNS);
  if (!claimed) {
    return { ok: false, reason: 'invalid_grant' };
  }

  return { ok: true, code: claimed };
}
