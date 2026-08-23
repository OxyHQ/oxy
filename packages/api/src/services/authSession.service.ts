/**
 * AuthSession claim service
 *
 * Implements the device-flow token exchange (RFC 8628-style). The
 * originating client holds a 128-bit `sessionToken` that nobody else
 * has seen — it was generated client-side, sent once on `POST /auth/session/create`,
 * never echoed back. After another authenticated principal authorizes
 * the session via `POST /auth/session/authorize/:sessionToken`
 * (bearer-authed), the originating client exchanges its `sessionToken`
 * here for the first access token.
 *
 * Safety properties:
 *  - Single-use: the atomic conditional `update ... where status = 'authorized'`
 *    claim transitions to `'consumed'` so a replayed sessionToken is
 *    rejected.
 *  - Time-bound: the `expires_at` deadline (default 5 minutes) gates the
 *    entire flow. Every read filters it in SQL or in the branch immediately
 *    after — the `db/expiry.ts` sweep is housekeeping, never the gate.
 *  - Bound to the bearer-authed authorizer: the session that we hand
 *    back was created with the authorizer's user identity in
 *    `/auth/session/authorize/:sessionToken`.
 *  - No secret is ever compared in process: Postgres resolves `session_token`
 *    and `authorize_code` through their unique indexes, and every branch this
 *    module takes is on the resulting row's STATUS, never on the credential.
 *
 * ## Reads never carry the claim credential
 *
 * `auth_sessions.session_token` is a PROTECTED column (`db/schema/protectedColumns.ts`):
 * possession of it alone exchanges an approved request for an access token, and
 * `POST /auth/session/claim` takes no bearer. Every read here therefore goes
 * through `publicColumns(authSessions, ...)`, and the two approval paths name the
 * column explicitly — they must return it so the route can notify the waiting
 * originator on its own secret channel.
 */

import type { Request } from 'express';
import { and, eq, gt, sql } from 'drizzle-orm';
import { isActAsEligibleKind } from '@oxyhq/contracts';
import { v7 as uuidv7 } from 'uuid';
import { publicColumns } from '@oxyhq/db/assert';
import { getDb } from '../config/postgres';
import { appGrants } from '../db/schema/appGrants';
import { applications } from '../db/schema/applications';
import { authChallenges } from '../db/schema/authChallenges';
import { authSessions } from '../db/schema/authSessions';
import { PROTECTED_COLUMNS_BY_TABLE } from '../db/schema/protectedColumns';
import { users } from '../db/schema/users';
import SignatureService from './signature.service';
import sessionService from './session.service';
import { issueAuthCode, AUTH_CODE_TTL_MS } from './oauthCode.service';
import { intersectScopes } from '../utils/applicationScopes';
import { isAllowedRedirectUri } from '../utils/oauthRedirect';
import { isTrustedApplication } from '../utils/trustedApplication';
import type { AccountRole } from '../utils/accountRoles';
import { logger } from '../utils/logger';

/**
 * An `auth_sessions` row as this module reads it — every column EXCEPT the
 * secret `session_token`. Nothing outside the two approval paths needs that
 * value, and the type keeps a caller from serializing it by accident.
 */
export type PublicAuthSession = Omit<typeof authSessions.$inferSelect, 'sessionToken'>;

/**
 * The OAuth binding of a bound request, read off the flat `oauth_*` columns.
 *
 * `subjectAccountId` is `string | null` rather than optional: NULL is the
 * stored value for "not delegated", and collapsing the two would lose the
 * distinction the `account:act_as` re-check keys on.
 */
export interface AuthSessionOAuthBinding {
  /** Exact redirect URI, validated against the Application allowlist at bind time. */
  redirectUri: string;
  /** PKCE challenge (S256 only — `plain` is rejected at bind time). */
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  /** Requested scopes, normalized exactly like `POST /auth/oauth/authorize`. */
  scopes: string[];
  /**
   * OPTIONAL delegated subject: the account the app will act AS. The approving
   * identity must hold `account:act_as` over it — re-verified at approval AND
   * at finalization, never trusted from the request.
   */
  subjectAccountId: string | null;
}

/**
 * The columns {@link resolveOAuthContext} needs to answer the question.
 *
 * A `Pick`, so it is structural: a caller selecting exactly these six columns
 * satisfies it without reading the whole row — which matters because
 * `auth_sessions.session_token` is a protected column and a whole-row read
 * would carry it.
 */
export type OAuthBindingSource = Pick<
  PublicAuthSession,
  | 'purpose'
  | 'oauthRedirectUri'
  | 'oauthCodeChallenge'
  | 'oauthCodeChallengeMethod'
  | 'oauthScopes'
  | 'oauthSubjectAccountId'
>;

export interface ClaimAuthSessionOptions {
  sessionToken: string;
}

export type ClaimAuthSessionOutcome =
  | { ok: true; authSession: PublicAuthSession }
  | {
      ok: false;
      reason: 'not_found' | 'expired' | 'cancelled' | 'pending' | 'already_consumed' | 'wrong_purpose';
    };

/**
 * The OAuth request binding of an OAuth-bound session, or null when the session
 * is an ordinary device sign-in (or a row whose binding is incomplete — treated
 * as absent, never as partially usable).
 *
 * `auth_sessions_oauth_binding_check` and `auth_sessions_oauth_purpose_check`
 * make an incomplete binding unrepresentable in the database, so the null
 * checks below are now a TYPE-level narrowing of nullable columns rather than
 * the only line of defence they were under Mongo.
 */
export function resolveOAuthContext(
  authSession: OAuthBindingSource
): AuthSessionOAuthBinding | null {
  if (authSession.purpose !== 'oauth_authorization') {
    return null;
  }
  const { oauthRedirectUri, oauthCodeChallenge, oauthCodeChallengeMethod, oauthScopes } =
    authSession;
  if (oauthRedirectUri === null || oauthCodeChallenge === null) {
    return null;
  }
  if (oauthCodeChallengeMethod !== 'S256') {
    return null;
  }
  return {
    redirectUri: oauthRedirectUri,
    codeChallenge: oauthCodeChallenge,
    codeChallengeMethod: oauthCodeChallengeMethod,
    scopes: oauthScopes ?? [],
    subjectAccountId: authSession.oauthSubjectAccountId,
  };
}

/** Why a delegated subject was refused. Logged; never surfaced to the client. */
export type DelegatedSubjectRejection =
  | 'not_found'
  | 'personal_account'
  | 'channel_account'
  | 'forbidden';

export type DelegatedSubjectOutcome =
  | { ok: true; role: AccountRole }
  | { ok: false; reason: DelegatedSubjectRejection };

/**
 * Authorise an IDENTITY to approve an app acting AS another account.
 *
 * Identity and account are different concepts: the human never becomes the
 * organisation, they authorise an application to act as it. The gate is the
 * EXISTING act-as mechanism — `accountService.verifyActingAs` (effective
 * membership, inherited through the account tree, carrying `account:act_as`) —
 * the same predicate `POST /accounts/:id/switch` and the managed-session
 * re-check use. No parallel permission system.
 *
 * Personal and channel accounts are refused as subjects, via the shared
 * `isActAsEligibleKind` predicate — assuming a human login would be
 * impersonation, and a channel is a content identity nobody acts as. Exactly the
 * same rule as the account-switch path, which is why both read one predicate
 * rather than each testing `kind === 'personal'` and silently admitting every
 * kind added afterwards.
 *
 * A malformed `subjectAccountId` simply matches no row and comes back
 * `not_found` — the old `isValidObjectId` guard existed only to keep Mongoose
 * from throwing a CastError and has no Postgres counterpart.
 *
 * `account.service` is imported LAZILY (mirroring `session.service`) so this
 * module's graph does not statically load the Account* models.
 */
export async function verifyDelegatedSubject(
  identityUserId: string,
  subjectAccountId: string
): Promise<DelegatedSubjectOutcome> {
  const [account] = await getDb()
    .select({ kind: users.kind, accountStatus: users.accountStatus })
    .from(users)
    .where(eq(users.id, subjectAccountId))
    .limit(1);
  if (!account || account.accountStatus === 'archived') {
    return { ok: false, reason: 'not_found' };
  }
  // `kind` is NOT NULL DEFAULT 'personal' here, so the Mongo-era `!account.kind`
  // branch for documents predating the field does not travel.
  if (!isActAsEligibleKind(account.kind)) {
    return {
      ok: false,
      reason: account.kind === 'channel' ? 'channel_account' : 'personal_account',
    };
  }

  const { accountService } = await import('./account.service.js');
  const role = await accountService.verifyActingAs(identityUserId, subjectAccountId);
  if (!role) {
    return { ok: false, reason: 'forbidden' };
  }
  return { ok: true, role };
}

/**
 * Gate an approval against the session's OPTIONAL delegated subject. Sessions
 * with no delegated subject pass straight through, so every approval path can
 * call this unconditionally.
 */
async function gateApprovalDelegation(
  authSession: OAuthBindingSource,
  approvingUserId: string
): Promise<{ ok: true } | { ok: false; reason: DelegatedSubjectRejection }> {
  const subjectAccountId = resolveOAuthContext(authSession)?.subjectAccountId;
  if (!subjectAccountId) {
    return { ok: true };
  }
  const outcome = await verifyDelegatedSubject(approvingUserId, subjectAccountId);
  if (outcome.ok) {
    return { ok: true };
  }
  return { ok: false, reason: outcome.reason };
}

/**
 * An OAuth-bound session NEVER mints a session on approval: its result is an
 * authorization code redeemed by the relying party at `POST /auth/oauth/token`.
 * Minting one anyway would leave a live, unclaimable session for the approving
 * identity on the RP's device, and would let the surface that only needs a code
 * pick up an access token instead.
 */
export function approvalMintsSession(authSession: Pick<PublicAuthSession, 'purpose'>): boolean {
  return authSession.purpose !== 'oauth_authorization';
}

/**
 * Atomically claim an authorized AuthSession. Only an `authorized` row
 * (set by `/auth/session/authorize/:sessionToken`) transitions to
 * `'consumed'`. Concurrent claim attempts see the loser path naturally
 * because the second conditional `update` no longer matches.
 *
 * NOTE: We do NOT throw here — the caller (route handler) chooses how to
 * surface each outcome to the client (uniform 401 for replay/expired,
 * 404 for not found, etc).
 */
export async function claimAuthSession(
  options: ClaimAuthSessionOptions
): Promise<ClaimAuthSessionOutcome> {
  const { sessionToken } = options;
  const db = getDb();

  // Peek first to give the route handler a precise reason. We don't
  // strictly need this — the atomic update below is the source of truth
  // — but it lets us distinguish "never existed" from "wrong status".
  // The peek does NOT leak existence to the network: the caller maps
  // multiple outcomes to the same 401 status code per RFC 6749 §5.2.
  const [existing] = await db
    .select(publicColumns(authSessions, PROTECTED_COLUMNS_BY_TABLE))
    .from(authSessions)
    .where(eq(authSessions.sessionToken, sessionToken))
    .limit(1);
  if (!existing) {
    return { ok: false, reason: 'not_found' };
  }

  // An OAuth authorization request is finalized into an authorization code via
  // `POST /auth/session/finalize/:sessionToken`; it must never hand its holder
  // an access token instead.
  if (existing.purpose === 'oauth_authorization') {
    return { ok: false, reason: 'wrong_purpose' };
  }

  if (existing.status === 'consumed') {
    return { ok: false, reason: 'already_consumed' };
  }
  if (existing.status === 'cancelled') {
    return { ok: false, reason: 'cancelled' };
  }
  if (existing.status === 'pending') {
    return { ok: false, reason: 'pending' };
  }
  if (existing.status === 'expired' || existing.expiresAt < new Date()) {
    return { ok: false, reason: 'expired' };
  }

  // status must be 'authorized' here — do the atomic claim.
  const [claimed] = await db
    .update(authSessions)
    .set({ status: 'consumed', consumedAt: new Date() })
    .where(and(eq(authSessions.id, existing.id), eq(authSessions.status, 'authorized')))
    .returning(publicColumns(authSessions, PROTECTED_COLUMNS_BY_TABLE));

  if (!claimed) {
    // Lost the race to a concurrent claim, or another transition fired.
    return { ok: false, reason: 'already_consumed' };
  }

  return { ok: true, authSession: claimed };
}

/**
 * Options for {@link authorizeSessionWithSignedChallenge}. `req` is forwarded to
 * `sessionService.createSession` for device attribution.
 */
export interface AuthorizeSignedOptions {
  authorizeCode: string;
  publicKey: string;
  challenge: string;
  signature: string;
  timestamp: number;
  deviceName?: string;
  deviceFingerprint?: string;
  req: Request;
}

export type AuthorizeSignedOutcome =
  | {
      ok: true;
      sessionToken: string;
      /** Absent for an OAuth authorization request — those mint no session. */
      sessionId?: string;
      userId: string;
      username?: string;
      publicKey: string;
    }
  | { ok: false; status: 400 | 401 | 403 | 404; message: string };

/**
 * Key-signed approval of a pending cross-app auth session (the "Sign in with
 * Oxy" QR / app-to-app handoff). The Commons vault approves with its LOCAL
 * secp256k1 key rather than a bearer token, so this proves key control via a
 * single-use challenge signature and derives the authorizing user from the
 * VERIFIED signer — never from a client-asserted id.
 *
 * Steps: (1) validate the `auth_challenges` row, verify the signature, and
 * atomically burn the challenge; (2) resolve the PENDING, unexpired session
 * bound to `authorizeCode`; (3) resolve the `users` row by the signer's
 * `public_key`; (4) mint a session for the originating app owned by that user;
 * (5) bind the result onto the session row. Does NOT throw — returns an outcome
 * the route maps to a status code (so success/failure handling stays in one
 * place).
 */
export async function authorizeSessionWithSignedChallenge(
  options: AuthorizeSignedOptions
): Promise<AuthorizeSignedOutcome> {
  const { authorizeCode, publicKey, challenge, signature, timestamp, deviceName, deviceFingerprint, req } = options;
  const db = getDb();

  // 1. Validate + cryptographically verify + atomically burn the challenge.
  //    Scope to signin-purpose challenges so a `rotate_key` challenge can NOT be
  //    spent to mint a session — the symmetric invariant to the rotate flow's
  //    purpose scoping. `purpose` is NOT NULL DEFAULT 'signin' here, so the
  //    Mongo-era `{ $in: ['signin', null] }` legacy branch does not travel.
  //    `expires_at > now()` is filtered HERE, not left to the expiry sweep: the
  //    sweep lags one interval, and a challenge spendable past its deadline is a
  //    live credential.
  const [authChallenge] = await db
    .select({ id: authChallenges.id })
    .from(authChallenges)
    .where(
      and(
        eq(authChallenges.publicKey, publicKey),
        eq(authChallenges.challenge, challenge),
        eq(authChallenges.used, false),
        eq(authChallenges.purpose, 'signin'),
        gt(authChallenges.expiresAt, new Date())
      )
    )
    .limit(1);
  if (!authChallenge) {
    return { ok: false, status: 401, message: 'Invalid or expired challenge' };
  }

  if (!SignatureService.verifyChallengeResponse(publicKey, challenge, signature, timestamp)) {
    return { ok: false, status: 401, message: 'Invalid signature' };
  }

  const burned = await db
    .update(authChallenges)
    .set({ used: true })
    .where(and(eq(authChallenges.id, authChallenge.id), eq(authChallenges.used, false)))
    .returning({ id: authChallenges.id });
  if (burned.length === 0) {
    // Lost the race — the challenge was already consumed concurrently.
    return { ok: false, status: 401, message: 'Invalid or expired challenge' };
  }

  // 2. Resolve the pending, unexpired session bound to this authorizeCode.
  const [authSession] = await db
    .select(publicColumns(authSessions, PROTECTED_COLUMNS_BY_TABLE))
    .from(authSessions)
    .where(and(eq(authSessions.authorizeCode, authorizeCode), eq(authSessions.status, 'pending')))
    .limit(1);
  if (!authSession) {
    return { ok: false, status: 404, message: 'Auth session not found or already processed' };
  }
  if (authSession.expiresAt < new Date()) {
    await db
      .update(authSessions)
      .set({ status: 'expired' })
      .where(eq(authSessions.id, authSession.id));
    return { ok: false, status: 400, message: 'Auth session has expired' };
  }

  // 3. The session user is the VERIFIED signer. `lower(btrim(public_key))` is
  //    the expression the unique index is built on — a plain equality here would
  //    be correct-looking, case-sensitive, and would not use that index.
  const [user] = await db
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(sql`lower(btrim(${users.publicKey})) = lower(btrim(${publicKey}))`)
    .limit(1);
  if (!user) {
    return { ok: false, status: 404, message: 'User not found' };
  }
  const userId = user.id;

  // 4. Delegated subject gate: when the request asks the identity to authorise
  //    the app acting AS another account, the VERIFIED signer must actually hold
  //    `account:act_as` over it. Refused before anything is bound.
  const delegation = await gateApprovalDelegation(authSession, userId);
  if (!delegation.ok) {
    logger.warn('[AuthSession] Delegated subject refused on signed approval', {
      authorizeCode: authorizeCode.substring(0, 8) + '...',
      identityUserId: userId,
      reason: delegation.reason,
    });
    return { ok: false, status: 403, message: 'Not authorized to act as the requested account' };
  }

  // 5. Mint the session for the originating app, owned by the signer. Give the
  //    claimant a NEW device boundary: neither its untrusted create payload nor
  //    the approver request may select an existing DeviceSession. Claim later
  //    returns a restore secret for this id, so reusing either device id would
  //    disclose a durable credential for that device's other accounts. An OAuth
  //    authorization request mints nothing here — see `approvalMintsSession`.
  let sessionId: string | undefined;
  if (approvalMintsSession(authSession)) {
    const [app] = await db
      .select({ name: applications.name })
      .from(applications)
      .where(eq(applications.id, authSession.applicationId))
      .limit(1);
    const appLabel = app ? app.name : 'App';
    const newSession = await sessionService.createSession(userId, req, {
      deviceName: deviceName || `${appLabel} App`,
      deviceFingerprint,
      deviceId: uuidv7(),
    });
    sessionId = newSession.sessionId;
  }

  // 6. Bind the result onto the session row — including WHICH identity approved.
  //    `session_token` is named explicitly: the route notifies the waiting
  //    originator on that secret channel, and nothing else in this flow has it.
  const [bound] = await db
    .update(authSessions)
    .set({
      status: 'authorized',
      authorizedBy: publicKey,
      authorizedUserId: userId,
      ...(sessionId ? { authorizedSessionId: sessionId } : {}),
    })
    .where(eq(authSessions.id, authSession.id))
    .returning({ sessionToken: authSessions.sessionToken });
  if (!bound) {
    return { ok: false, status: 404, message: 'Auth session not found or already processed' };
  }

  return {
    ok: true,
    sessionToken: bound.sessionToken,
    ...(sessionId ? { sessionId } : {}),
    userId,
    username: user.username ?? undefined,
    publicKey,
  };
}

/** Options for {@link authorizeSessionWithBearer}. */
export interface AuthorizeBearerOptions {
  authorizeCode: string;
  authenticatedUserId: string;
  authenticatedPublicKey?: string;
  deviceName?: string;
  deviceFingerprint?: string;
  req: Request;
}

export type AuthorizeBearerOutcome =
  | {
      ok: true;
      sessionToken: string;
      /** Absent for an OAuth authorization request — those mint no session. */
      sessionId?: string;
    }
  | { ok: false; status: 400 | 403 | 404; message: string };

/**
 * Bearer approval of a pending cross-app auth session, keyed on the PUBLIC
 * `authorizeCode` (the auth.oxy.so passkey hub, b2 — the approver
 * authenticates via bearer token, never a local secp256k1 key, so it can't
 * use {@link authorizeSessionWithSignedChallenge}). The authenticated
 * principal is the bearer's `req.user` — never anything client-asserted.
 *
 * The claim is ATOMIC: a single conditional `update` flips `pending` ->
 * `authorized` conditioned on that exact prior status + an unexpired
 * `expires_at`, so two concurrent authorizes of the same code cannot both mint
 * a session — the loser's update matches nothing and gets treated as
 * already-processed, before ever calling `sessionService.createSession`.
 * Mirrors {@link claimAuthSession}'s peek-then-atomic-claim shape.
 *
 * `originVerified` is an anti-phishing signal computed at `session/create`
 * time from the REAL browser `Origin` header, not something this bearer
 * caller can influence — an authorize with `originVerified: false` is
 * exactly the shape a login-CSRF attempt would take (an attacker's own
 * session, or an unregistered/third-party origin), so it's logged for audit
 * even though the CLIENT-side consent screen (mandatory confirmation +
 * non-suppressible acknowledgement) is the primary defense.
 */
export async function authorizeSessionWithBearer(
  options: AuthorizeBearerOptions
): Promise<AuthorizeBearerOutcome> {
  const { authorizeCode, authenticatedUserId, authenticatedPublicKey, deviceName, deviceFingerprint, req } = options;
  const db = getDb();

  // Peek first for a precise reason (mirrors claimAuthSession) — the atomic
  // update below is the actual source of truth for the claim.
  const [existing] = await db
    .select(publicColumns(authSessions, PROTECTED_COLUMNS_BY_TABLE))
    .from(authSessions)
    .where(eq(authSessions.authorizeCode, authorizeCode))
    .limit(1);
  if (!existing || existing.status !== 'pending') {
    return { ok: false, status: 404, message: 'Auth session not found or already processed' };
  }
  if (existing.expiresAt < new Date()) {
    return { ok: false, status: 400, message: 'Auth session has expired' };
  }

  // Delegated subject gate — the authenticated approver must hold
  // `account:act_as` over the account the app would act as. Checked BEFORE the
  // atomic claim so a refusal leaves the request approvable by someone who does.
  const delegation = await gateApprovalDelegation(existing, authenticatedUserId);
  if (!delegation.ok) {
    logger.warn('[AuthSession] Delegated subject refused on bearer approval', {
      authorizeCode: authorizeCode.substring(0, 8) + '...',
      identityUserId: authenticatedUserId,
      reason: delegation.reason,
    });
    return { ok: false, status: 403, message: 'Not authorized to act as the requested account' };
  }

  // `session_token` is named explicitly on the way out: the route notifies the
  // waiting originator on that secret channel, and the bearer caller here only
  // ever held the PUBLIC `authorize_code`.
  const [claimed] = await db
    .update(authSessions)
    .set({
      status: 'authorized',
      authorizedUserId: authenticatedUserId,
      ...(authenticatedPublicKey ? { authorizedBy: authenticatedPublicKey } : {}),
    })
    .where(
      and(
        eq(authSessions.id, existing.id),
        eq(authSessions.status, 'pending'),
        gt(authSessions.expiresAt, new Date())
      )
    )
    .returning({
      ...publicColumns(authSessions, PROTECTED_COLUMNS_BY_TABLE),
      sessionToken: authSessions.sessionToken,
    });
  if (!claimed) {
    // Lost the race to a concurrent authorize (or expired between the peek
    // and here) — the loser must NOT mint a session.
    return { ok: false, status: 404, message: 'Auth session not found or already processed' };
  }

  if (!claimed.originVerified) {
    logger.warn('Auth session authorized (bearer, by code) with an unverified origin', {
      authorizeCode: authorizeCode.substring(0, 8) + '...',
      userId: authenticatedUserId,
      applicationId: claimed.applicationId,
      boundOrigin: claimed.boundOrigin,
    });
  }

  // An OAuth authorization request mints nothing here — its result is the
  // authorization code produced by finalization.
  if (!approvalMintsSession(claimed)) {
    return { ok: true, sessionToken: claimed.sessionToken };
  }

  const [app] = await db
    .select({ name: applications.name })
    .from(applications)
    .where(eq(applications.id, claimed.applicationId))
    .limit(1);
  const appLabel = app ? app.name : 'App';
  const newSession = await sessionService.createSession(authenticatedUserId, req, {
    deviceName: deviceName || `${appLabel} App`,
    deviceFingerprint,
    // The unauthenticated requester must never choose an existing device whose
    // durable restore secret it will receive from `/auth/session/claim`.
    deviceId: uuidv7(),
  });

  // Only the winner of the atomic claim above ever reaches here, so this
  // final write is not racy — it just attaches the minted session id.
  await db
    .update(authSessions)
    .set({ authorizedSessionId: newSession.sessionId })
    .where(eq(authSessions.id, claimed.id));

  return { ok: true, sessionToken: claimed.sessionToken, sessionId: newSession.sessionId };
}

/** Options for {@link finalizeOAuthAuthorization}. */
export interface FinalizeOAuthAuthorizationOptions {
  /** The SECRET credential held only by the originating client. */
  sessionToken: string;
}

/**
 * Why a finalization was refused. Logged server-side ONLY — every failure is
 * collapsed to one generic client error so nothing enumerates which precondition
 * failed (RFC 6749 §5.2).
 */
export type FinalizeOAuthRejection =
  | 'not_found'
  | 'wrong_purpose'
  | 'not_authorized'
  | 'expired'
  | 'already_finalized'
  | 'application_unavailable'
  | 'redirect_uri_unregistered'
  | 'delegation_denied'
  | 'issue_failed';

export type FinalizeOAuthOutcome =
  | { ok: true; code: string; redirectUri: string; expiresIn: number }
  | { ok: false; reason: FinalizeOAuthRejection };

/**
 * Turn an APPROVED OAuth-bound `AuthSession` into the standard OAuth result: one
 * short-lived, single-use `AuthCode`. This is where every delivery surface
 * (popup, push, QR, verified app link) converges — there is no second code
 * minter, and no access token is ever handed out to finalize a request.
 *
 * Single-use is structural, not advisory: the code's id is RESERVED by the
 * same atomic conditional `update` that spends the session
 * (`finalized_auth_code_id is null` -> the reserved id, `authorized` ->
 * `consumed`). Two concurrent finalizations cannot both match that filter, so
 * exactly one ever reaches `issueAuthCode`. If minting then fails, the request
 * stays spent and the user restarts — the correct fail-closed direction. That
 * reservation is precisely why `auth_sessions.finalized_auth_code_id` carries
 * NO foreign key: the id is written BEFORE the row it names exists, and may
 * never come to name one.
 *
 * Bindings are RE-verified at finalization, never assumed from bind time: the
 * application must still be active, the redirect URI must still be registered,
 * and a delegated subject's `account:act_as` permission must still hold.
 */
export async function finalizeOAuthAuthorization(
  options: FinalizeOAuthAuthorizationOptions
): Promise<FinalizeOAuthOutcome> {
  const { sessionToken } = options;
  const db = getDb();

  const [existing] = await db
    .select(publicColumns(authSessions, PROTECTED_COLUMNS_BY_TABLE))
    .from(authSessions)
    .where(eq(authSessions.sessionToken, sessionToken))
    .limit(1);
  if (!existing) {
    return { ok: false, reason: 'not_found' };
  }

  const oauth = resolveOAuthContext(existing);
  if (!oauth) {
    return { ok: false, reason: 'wrong_purpose' };
  }
  if (existing.finalizedAuthCodeId) {
    return { ok: false, reason: 'already_finalized' };
  }
  if (existing.status !== 'authorized') {
    return { ok: false, reason: 'not_authorized' };
  }
  if (existing.expiresAt < new Date()) {
    return { ok: false, reason: 'expired' };
  }

  // WHICH identity approved — recorded at approval time, never client-asserted.
  const identityUserId = existing.authorizedUserId;
  if (!identityUserId) {
    return { ok: false, reason: 'not_authorized' };
  }

  const [app] = await db
    .select({
      id: applications.id,
      scopes: applications.scopes,
      redirectUris: applications.redirectUris,
      type: applications.type,
      isOfficial: applications.isOfficial,
      isInternal: applications.isInternal,
    })
    .from(applications)
    .where(and(eq(applications.id, existing.applicationId), eq(applications.status, 'active')))
    .limit(1);
  if (!app) {
    return { ok: false, reason: 'application_unavailable' };
  }
  if (!isAllowedRedirectUri(app, oauth.redirectUri)) {
    return { ok: false, reason: 'redirect_uri_unregistered' };
  }

  // The code is issued FOR the delegated subject when there is one; the
  // approving identity is recorded alongside it, never merged into it.
  const subjectAccountId = oauth.subjectAccountId;
  if (subjectAccountId) {
    const delegation = await verifyDelegatedSubject(identityUserId, subjectAccountId);
    if (!delegation.ok) {
      logger.warn('[AuthSession] Delegated subject refused on finalize', {
        identityUserId,
        reason: delegation.reason,
      });
      return { ok: false, reason: 'delegation_denied' };
    }
  }

  // ATOMIC single-use claim: reserve the code id AND spend the request in one
  // update. The loser of a concurrent race matches nothing and mints nothing.
  const codeId = uuidv7();
  const now = new Date();
  const claimed = await db
    .update(authSessions)
    .set({ finalizedAuthCodeId: codeId, status: 'consumed', consumedAt: now })
    .where(
      and(
        eq(authSessions.id, existing.id),
        eq(authSessions.purpose, 'oauth_authorization'),
        eq(authSessions.status, 'authorized'),
        sql`${authSessions.finalizedAuthCodeId} is null`
      )
    )
    .returning({ id: authSessions.id });
  if (claimed.length === 0) {
    return { ok: false, reason: 'already_finalized' };
  }

  const grantUserId = subjectAccountId || identityUserId;

  const appScopes = [...app.scopes];
  const effectiveScopes =
    oauth.scopes.length > 0 ? intersectScopes(oauth.scopes, appScopes) : appScopes;

  try {
    const { code } = await issueAuthCode({
      codeId,
      userId: grantUserId,
      appId: app.id,
      redirectUri: oauth.redirectUri,
      codeChallenge: oauth.codeChallenge,
      codeChallengeMethod: 'S256',
      scopes: effectiveScopes,
      ...(subjectAccountId ? { operatedByUserId: identityUserId } : {}),
      // Thread the originating RP device so the token exchange lands on the same
      // DeviceSession the flow started from instead of sprawling a new device.
      ...(existing.deviceId ? { deviceId: existing.deviceId } : {}),
    });

    // Same returning-user consent bookkeeping as `POST /auth/oauth/authorize`:
    // only third-party grants are revocable "Connected apps" entries; trusted
    // apps are auto-approved and never recorded. Best-effort — a bookkeeping
    // failure must never invalidate an already-issued code.
    if (!isTrustedApplication(app)) {
      try {
        await db
          .insert(appGrants)
          .values({
            userId: grantUserId,
            applicationId: app.id,
            scopes: effectiveScopes,
            firstGrantedAt: now,
            lastUsedAt: now,
          })
          .onConflictDoUpdate({
            target: [appGrants.userId, appGrants.applicationId],
            set: {
              lastUsedAt: now,
              updatedAt: now,
              // Mongo's `$addToSet: { scopes: { $each: … } }`. The union keeps
              // each scope's FIRST position, so an existing grant's order is
              // preserved and genuinely new scopes are appended — `array_agg
              // (distinct …)` alone would silently re-sort the stored set.
              scopes: sql`(
                select coalesce(array_agg(scope order by first_seen), '{}'::text[])
                from (
                  select scope, min(pos) as first_seen
                  from unnest(${appGrants.scopes} || excluded.scopes)
                    with ordinality as merged(scope, pos)
                  group by scope
                ) as unioned
              )`,
            },
          });
      } catch (error) {
        logger.warn('[AuthSession] Failed to record AppGrant on finalize', {
          applicationId: app.id,
          err: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.info('[AuthSession] OAuth authorization finalized', {
      sessionToken: sessionToken.substring(0, 8) + '...',
      applicationId: app.id,
      identityUserId,
      delegated: Boolean(subjectAccountId),
    });

    return {
      ok: true,
      code,
      redirectUri: oauth.redirectUri,
      expiresIn: Math.floor(AUTH_CODE_TTL_MS / 1000),
    };
  } catch (error) {
    // The request is already spent — fail closed and make the user restart
    // rather than leave a second minting opportunity open.
    logger.error(
      '[AuthSession] Authorization code mint failed after the request was spent',
      error instanceof Error ? error : new Error(String(error)),
      { sessionToken: sessionToken.substring(0, 8) + '...', applicationId: app.id }
    );
    return { ok: false, reason: 'issue_failed' };
  }
}
