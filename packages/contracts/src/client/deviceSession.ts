/**
 * Device-session checks, without Zod. Schemas: `../deviceSession.ts`.
 *
 * Part of `@oxy.so/contracts/client`: never import `zod` here (see `./check.ts`).
 */

import type {
  ActiveToken,
  DeviceBackgroundCredentialResponse,
  DeviceJoinCodeResponse,
  DeviceJoinResponse,
  DeviceRegisterResponse,
  DeviceSessionState,
  DeviceSessionSync,
  DeviceTokenMintResponse,
  SessionAccountsChangedEvent,
} from '../deviceSession';
import {
  array,
  exact,
  int,
  minLength,
  nonnegative,
  nullable,
  number,
  object,
  oneOf,
  optional,
  positive,
  string,
} from './check';

/* -------------------------------------------------------------------------- */
/*  Instant cross-app session sync (token-free socket signal)                 */
/* -------------------------------------------------------------------------- */

/**
 * Name of the token-free Socket.IO event emitted to room `user:<userId>` on
 * every DeviceSession mutation that changes what is signed in for that user.
 *
 * This is a pure SIGNAL — it carries NO access token, NO deviceSecret and NO
 * account bodies. A client that receives it re-fetches its authenticated
 * session/account state (`GET /session/device/state`, `GET /accounts`). Unlike
 * `session_state` (scoped to `device:<deviceId>`, i.e. a single origin), this
 * reaches ALL of a user's connected sockets across their devices/origins so
 * every Oxy app reflects an add / switch / signout instantly.
 */
export const SESSION_ACCOUNTS_CHANGED_EVENT = 'session_accounts_changed';

/* -------------------------------------------------------------------------- */
/*  Response checks                                                           */
/* -------------------------------------------------------------------------- */

const SESSION_ACCOUNTS_CHANGED_REASONS = ['login', 'add', 'switch', 'signout', 'revoke'] as const;

const sessionAccount = object({
  accountId: string(),
  sessionId: string(),
  authuser: number(int, nonnegative),
  operatedByUserId: optional(string()),
});

export const deviceSessionStateCheck = exact<DeviceSessionState>()(
  object({
    deviceId: string(),
    accounts: array(sessionAccount),
    activeAccountId: nullable(string()),
    revision: number(int, nonnegative),
    updatedAt: number(),
  }),
);

export const activeTokenCheck = exact<ActiveToken>()(
  object({ accessToken: string(), expiresAt: string() }),
);

export const deviceSessionSyncCheck = exact<DeviceSessionSync>()(
  object({ state: deviceSessionStateCheck, activeToken: nullable(activeTokenCheck) }),
);

export const deviceTokenMintResponseCheck = exact<DeviceTokenMintResponse>()(
  object({
    accessToken: string(),
    expiresAt: string(),
    nextDeviceSecret: string(),
    state: deviceSessionStateCheck,
  }),
);

export const sessionAccountsChangedEventCheck = exact<SessionAccountsChangedEvent>()(
  object({
    userId: string(),
    revision: number(int, nonnegative),
    reason: oneOf(SESSION_ACCOUNTS_CHANGED_REASONS),
  }),
);

export const deviceBackgroundCredentialResponseCheck = exact<DeviceBackgroundCredentialResponse>()(
  object({
    deviceId: string(minLength(1)),
    secret: string(minLength(1)),
    accountId: string(minLength(1)),
    expiresAt: string(),
  }),
);

export const deviceRegisterResponseCheck = exact<DeviceRegisterResponse>()(
  object({ deviceId: string(minLength(1)), deviceSecret: string(minLength(1)) }),
);

export const deviceJoinResponseCheck = exact<DeviceJoinResponse>()(deviceRegisterResponseCheck);

export const deviceJoinCodeResponseCheck = exact<DeviceJoinCodeResponse>()(
  object({ code: string(minLength(1)), expiresIn: number(int, positive) }),
);
