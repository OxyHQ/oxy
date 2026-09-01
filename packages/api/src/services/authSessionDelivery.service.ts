/**
 * Automatic delivery of a pending authorization request to the approving
 * identity's own vault installs, plus the delivery-progress bookkeeping that
 * goes with it.
 *
 * Two rules define this module's security posture:
 *
 *  1. **The target user is NEVER derived from the request.** The caller passes
 *     the identity resolved from a bearer token, and delivery targets that
 *     user's OWN installs and nothing else. A push is therefore impossible to
 *     trigger from a username or email typed into an unauthenticated browser.
 *  2. **Eligibility is registry-based.** Only installs registered by an
 *     `Application` carrying the {@link IDENTITY_APPROVAL_CAPABILITY} staff-only
 *     capability are targeted — never a hardcoded client id, bundle id or app
 *     name.
 *
 * Zero eligible installs is a NORMAL outcome (the client falls back to a QR),
 * not an error, and a push transport failure degrades to exactly the same
 * outcome — delivery must never fail the auth flow.
 *
 * ## What the Postgres port changed
 *
 * `auth_sessions.session_token` is a PROTECTED column
 * (`db/schema/protectedColumns.ts`): possession of it alone exchanges an
 * approved request for an access token. Both reads here therefore NAME the
 * columns they need instead of selecting the row — `sessionToken` is one of
 * them, because the route has to wake the waiting originator on its own secret
 * channel, and naming it is how that read reads differently from an ordinary
 * one.
 *
 * Eligibility became ONE join instead of two round trips. `capabilities` is a
 * `text[]` with a GIN index (`applications_capabilities_idx` — ADDED by the
 * port; Mongo declared none and scanned the collection on every delivery), so
 * `capabilities @> array['identity:approval']` is an index scan, and an
 * install with a NULL `application_id` — "not scoped to any application" —
 * simply does not join, exactly as Mongo's `$in` over the capable ids excluded
 * it.
 */

import { and, arrayContains, eq, gt, isNull } from 'drizzle-orm';

import { getDb } from '../config/postgres';
import { applications } from '../db/schema/applications';
import { authSessions } from '../db/schema/authSessions';
import { pushTokens } from '../db/schema/pushTokens';
import { pushService } from './push.service';
import { IDENTITY_APPROVAL_CAPABILITY } from '../utils/applicationCapabilities';
// The Android channel the approval push is sent on. NOT an iOS `categoryId`:
// the notification carries no action buttons, so it can only be opened (which
// routes into the normal in-vault approval screen) or dismissed. It is a wire
// contract because the vault must create a channel with this exact id before a
// push can land — Android 8+ drops a notification whose channel it does not
// know, silently and with no error on either side.
import { IDENTITY_APPROVAL_PUSH_CHANNEL } from '@oxyhq/contracts';
import { logger } from '../utils/logger';

/** Runtime type discriminator of the push payload, mirrored by the vault. */
export const IDENTITY_APPROVAL_PUSH_TYPE = 'oxy_commons_auth_request';

/**
 * Static notification copy. Deliberately carries NO request-derived data — not
 * the application name, not the origin, not the account. The vault re-fetches
 * the authoritative application / scopes / origin / expiry from
 * `GET /auth/session/approve-info/:authorizeCode` after the user opens it.
 */
const PUSH_TITLE = 'Sign-in request';
const PUSH_BODY = 'Open Commons to review this request.';

/**
 * The ONLY payload delivered. Exactly two fields: a type discriminator and the
 * deep link carrying the PUBLIC approval handle. No display data (which would be
 * untrusted at the receiver anyway) and no secrets — never the `sessionToken`.
 */
export type IdentityApprovalPushPayload = {
  type: typeof IDENTITY_APPROVAL_PUSH_TYPE;
  approvalUrl: string;
};

export function buildApprovalUrl(authorizeCode: string): string {
  return `oxycommons://approve?v=1&code=${encodeURIComponent(authorizeCode)}`;
}

export type DeliverAuthRequestOutcome =
  | {
      ok: true;
      /** Secret channel of the waiting originator — for the socket wake ONLY. */
      sessionToken: string;
      /** At least one install accepted the push. */
      delivered: boolean;
      /** How many eligible installs were targeted. A COUNT — never PII. */
      targets: number;
    }
  | { ok: false; status: 400 | 404; message: string };

/**
 * Resolve the push tokens of the user's installs that may approve an identity
 * request. Returns an empty array when the user has no such install, or when no
 * application currently carries the capability at all.
 *
 * The join IS the eligibility rule: an install whose `application_id` is NULL
 * ("not scoped to any application") joins nothing and is never targeted, and a
 * scoped install is targeted only while its application is `active` AND carries
 * the staff-controlled capability.
 */
async function resolveIdentityApprovalTokens(userId: string): Promise<string[]> {
  const installs = await getDb()
    .select({ token: pushTokens.token })
    .from(pushTokens)
    .innerJoin(applications, eq(pushTokens.applicationId, applications.id))
    .where(
      and(
        eq(pushTokens.userId, userId),
        eq(applications.status, 'active'),
        arrayContains(applications.capabilities, [IDENTITY_APPROVAL_CAPABILITY]),
      ),
    );

  return installs.map((install) => install.token);
}

/**
 * Push a PENDING authorization request to the authenticated identity's own
 * approval-capable installs.
 *
 * @param authorizeCode  Public approval handle of the request.
 * @param identityUserId The AUTHENTICATED user — the sole delivery target.
 */
export async function deliverAuthRequestToIdentityApps(params: {
  authorizeCode: string;
  identityUserId: string;
}): Promise<DeliverAuthRequestOutcome> {
  const { authorizeCode, identityUserId } = params;

  // Names `sessionToken` deliberately: it is a PROTECTED column and the route
  // needs it to wake the waiting originator. Nothing else on the row is read,
  // so nothing else is selected.
  const [authSession] = await getDb()
    .select({
      sessionToken: authSessions.sessionToken,
      status: authSessions.status,
      expiresAt: authSessions.expiresAt,
    })
    .from(authSessions)
    .where(eq(authSessions.authorizeCode, authorizeCode))
    .limit(1);
  if (!authSession) {
    return { ok: false, status: 404, message: 'Auth session not found' };
  }

  if (authSession.expiresAt.getTime() <= Date.now()) {
    // Same lazy expiry the sibling approval endpoints perform. Conditioned on
    // `pending` so a concurrent approval is never overwritten.
    await getDb()
      .update(authSessions)
      .set({ status: 'expired' })
      .where(
        and(eq(authSessions.authorizeCode, authorizeCode), eq(authSessions.status, 'pending')),
      );
    return { ok: false, status: 400, message: 'Auth session has expired' };
  }

  if (authSession.status !== 'pending') {
    return { ok: false, status: 400, message: 'Auth session is no longer pending' };
  }

  const tokens = await resolveIdentityApprovalTokens(identityUserId);
  if (tokens.length === 0) {
    // Normal: this identity has no vault install on any device. The client falls
    // back to the QR / deep-link surfaces.
    return { ok: true, sessionToken: authSession.sessionToken, delivered: false, targets: 0 };
  }

  const payload: IdentityApprovalPushPayload = {
    type: IDENTITY_APPROVAL_PUSH_TYPE,
    approvalUrl: buildApprovalUrl(authorizeCode),
  };

  let accepted = 0;
  try {
    const dispatched = await pushService.sendPushToTokens({
      userId: identityUserId,
      tokens,
      title: PUSH_TITLE,
      body: PUSH_BODY,
      channelId: IDENTITY_APPROVAL_PUSH_CHANNEL,
      data: payload,
    });
    accepted = dispatched.accepted;
  } catch (err) {
    // The push service already swallows its own transport errors; this is the
    // belt-and-braces guard that keeps a delivery problem from ever surfacing as
    // an auth failure. The client simply falls back.
    logger.warn('[AuthSession] Identity approval push failed', {
      authorizeCode: authorizeCode.substring(0, 8) + '...',
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const delivered = accepted > 0;

  if (delivered) {
    // Progress is a TIMESTAMP, never a status — the state machine is untouched.
    // Recorded once, and only while the request is still pending. `status` is
    // not in the `set`, so this update cannot move it even by accident.
    await getDb()
      .update(authSessions)
      .set({ pushSentAt: new Date() })
      .where(
        and(
          eq(authSessions.authorizeCode, authorizeCode),
          eq(authSessions.status, 'pending'),
          isNull(authSessions.pushSentAt),
        ),
      );
  }

  return {
    ok: true,
    sessionToken: authSession.sessionToken,
    delivered,
    targets: tokens.length,
  };
}

export type MarkAuthRequestOpenedOutcome =
  | {
      ok: true;
      /** Secret channel of the waiting originator — for the socket wake ONLY. */
      sessionToken: string;
      /** True only on the FIRST record; a repeat call is a no-op. */
      recorded: boolean;
    }
  | { ok: false; status: 404; message: string };

/**
 * Record that the approval surface opened a PENDING request.
 *
 * Idempotent (`openedAt` is written at most once) and pending-only, via a single
 * conditional update: it can never move `status`, revive an expired request, or
 * overwrite an earlier timestamp.
 */
export async function markAuthRequestOpened(
  authorizeCode: string,
): Promise<MarkAuthRequestOpenedOutcome> {
  // Same protected-column posture as the delivery read: `sessionToken` is named
  // because the route wakes the originator with it, and nothing else is.
  const [authSession] = await getDb()
    .select({ sessionToken: authSessions.sessionToken })
    .from(authSessions)
    .where(eq(authSessions.authorizeCode, authorizeCode))
    .limit(1);
  if (!authSession) {
    return { ok: false, status: 404, message: 'Auth session not found' };
  }

  // The `expires_at > now()` half is carried over VERBATIM. `db/expiry.ts`
  // sweeps `auth_sessions` on a one-hour grace so a late poll can answer
  // "expired" rather than "never existed" — dropping this predicate because
  // "the sweep handles it" would turn that bounded lag into a window in which
  // an expired request still records progress.
  const recorded = await getDb()
    .update(authSessions)
    .set({ openedAt: new Date() })
    .where(
      and(
        eq(authSessions.authorizeCode, authorizeCode),
        eq(authSessions.status, 'pending'),
        isNull(authSessions.openedAt),
        gt(authSessions.expiresAt, new Date()),
      ),
    )
    .returning({ id: authSessions.id });

  return {
    ok: true,
    sessionToken: authSession.sessionToken,
    recorded: recorded.length > 0,
  };
}
