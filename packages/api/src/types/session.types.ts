/**
 * Session Types
 * 
 * Centralized type definitions for session-related operations.
 */

import type { CachedSession } from '../utils/sessionCache';
import type { AccountDocument } from '../services/user.service';
import type { DeviceFingerprintInput } from '../utils/deviceUtils';
import type { AccessTokenIdentity, SessionTokenPayload } from '../utils/sessionUtils';

export interface SessionValidationResult {
  session: CachedSession;
  /**
   * The authenticated account, as `userService.readAccountDocument` builds it —
   * the SAME serializer `GET /users/me/data` and `PUT /users/resolve` return,
   * so `req.user` and those responses can never describe the same account
   * differently.
   *
   * It carries `_id` (the account id) beside `id`, which is the documented
   * contract (`@oxyhq/contracts` `resolveUserId` = `user.id ?? user._id`). See
   * `middleware/auth.ts` for why `req.user._id` — not `id` — is the account id
   * every authenticated call site reads.
   */
  user: AccountDocument;
  payload: SessionTokenPayload;
  /**
   * Who the bearer resolves to once its claims have been checked against the
   * session row (issue #937, Phase 6) — subject and actor kept apart, plus the
   * application, device context and scopes the session is bound to.
   *
   * This, not `payload`, is what a route may act on: `payload` is what the
   * token SAID, `token` is what survived validation. It is where the device
   * lane reads `clientId` to refuse a third-party bearer.
   */
  token: AccessTokenIdentity;
}

export interface SessionCreateOptions {
  deviceName?: string;
  deviceFingerprint?: DeviceFingerprintInput;
  /**
   * When set, the session's deviceId is derived deterministically from
   * (userId, stableDeviceKey) via `deriveServiceDeviceId` so one (user, RP)
   * reuses a single session, independent of request IP/UA. Originally added
   * for IdP server-minted sessions; no current call site passes this option
   * post-wave-2 (kept for any future server-minted-session caller that needs
   * the same stable-per-RP-session property). Real device logins (no
   * stableDeviceKey) are unaffected.
   */
  stableDeviceKey?: string;
  /**
   * An explicit central deviceId, used verbatim (bypasses stableDeviceKey/UA-IP
   * derivation). Precedence: deviceId > stableDeviceKey > UA/IP > random.
   */
  deviceId?: string;
  /**
   * The OPERATOR user id when this session is minted by switching INTO a managed
   * account (`userId` = the managed account). Recorded on the session for audit
   * and to bind its validity to the operator's `account:act_as` membership.
   */
  operatedByUserId?: string;
  /**
   * Bind this session to ONE application (issue #937, Phase 6). Set only where
   * the session belongs to a single application and nothing else can reach it
   * — an untrusted OAuth client's exchange. A shared device session that
   * several official apps use is deliberately left unbound, because `azp`
   * naming one of them would be false for the others.
   *
   * Binding also NARROWS session reuse: a bound mint may only reuse a session
   * already bound to the same application, so an OAuth exchange can never be
   * handed the device's existing first-party session.
   */
  application?: {
    applicationId: string;
    clientId: string;
    scopes: string[];
  };
  /**
   * Bind this session to a device account context (ADR 0001) at mint time.
   * Passed by `activateContext`, which knows both ids before it mints. The
   * device-login lane cannot: its context row is created after the session, so
   * it binds afterwards via `deviceSessionService.bindSessionToContext`.
   */
  deviceContext?: {
    deviceSessionId: string;
    deviceContextId: string;
  };
}

export interface SessionRefreshResult {
  accessToken: string;
  refreshToken: string;
  session: CachedSession;
}

