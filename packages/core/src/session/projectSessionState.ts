import type { DeviceSessionState } from '@oxyhq/contracts';
import type { ClientSession } from '../models/session';
import type { User } from '../models/interfaces';

/**
 * Pure projection helpers: `DeviceSessionState` (the device-scoped
 * multi-account session-sync state produced by `SessionClient`) -> the
 * shapes `@oxyhq/services` consumers render today
 * (`ClientSession[]`, an active session id, an active `User`).
 *
 * No I/O. The caller fetches profiles via
 * `oxyServices.getUsersByIds(accountIdsOf(state))` and builds `usersById`
 * from the result before calling `deviceStateToClientSessions` /
 * `activeUserOf`.
 *
 * Each projection takes an OPTIONAL `pinnedAccountId`. Omit it (or pass `null`)
 * and the projection resolves the device's `activeAccountId` exactly as before.
 * Pass it — an IDENTITY-BOUND client, whose user is fixed by the local identity
 * key — and the projection resolves THAT account instead, so an account switch
 * made by another app on the same device changes `state` but never the user this
 * client renders.
 */

/**
 * The account a projection should resolve: the pin when one is supplied and
 * non-empty, else the device's active account. An empty-string pin is treated as
 * "not pinned" rather than as an account that can never match.
 *
 * Exported so no other projection over the same state answers it a second,
 * subtly different way. A null state with
 * a pin still resolves to the pin: the pinned identity is bound by a local key,
 * not by device membership.
 */
export function boundAccountIdOf(
  state: DeviceSessionState | null,
  pinnedAccountId?: string | null,
): string | null {
  if (typeof pinnedAccountId === 'string' && pinnedAccountId.length > 0) {
    return pinnedAccountId;
  }
  return state?.activeAccountId ?? null;
}

/**
 * Maps every `SessionAccount` in `state.accounts` to a `ClientSession`.
 *
 * `DeviceSessionState` carries no per-account `expiresAt` / `lastActive` —
 * both are set to `state.updatedAt` (converted to an ISO-8601 string; the
 * wire value is an epoch-ms number) as a provisional value.
 *
 * `usersById` is accepted for signature symmetry with `activeUserOf` even
 * though `ClientSession` only stores `userId` — a session is still
 * projected for an account whose id is absent from `usersById` (no
 * placeholder user is fabricated).
 *
 * `isCurrent` marks the PINNED account when one is supplied, so it can never
 * disagree with {@link activeSessionIdOf} / {@link activeUserOf} for the same
 * pin.
 */
export function deviceStateToClientSessions(
  state: DeviceSessionState,
  usersById: Map<string, User>,
  pinnedAccountId?: string | null,
): ClientSession[] {
  const provisionalTimestamp = new Date(state.updatedAt).toISOString();
  const boundAccountId = boundAccountIdOf(state, pinnedAccountId);
  return state.accounts.map((account) => ({
    sessionId: account.sessionId,
    deviceId: state.deviceId,
    // provisional: expiresAt/lastActive are not carried on DeviceSessionState
    expiresAt: provisionalTimestamp,
    lastActive: provisionalTimestamp,
    userId: account.accountId,
    isCurrent: account.accountId === boundAccountId,
    authuser: account.authuser,
    operatedByUserId: account.operatedByUserId,
  }));
}

/**
 * The bound account's `sessionId`, or `null` when there is no state, no bound
 * account, or that account has no session on this device.
 *
 * A pinned account that is ABSENT from `state.accounts` yields `null` — the
 * honest signal that this device no longer carries a session for the pinned
 * identity, which the caller answers by re-establishing the identity session
 * (never by adopting the device's active account).
 */
export function activeSessionIdOf(
  state: DeviceSessionState | null,
  pinnedAccountId?: string | null,
): string | null {
  if (state === null) {
    return null;
  }
  const boundAccountId = boundAccountIdOf(state, pinnedAccountId);
  if (boundAccountId === null) {
    return null;
  }
  const boundAccount = state.accounts.find((account) => account.accountId === boundAccountId);
  return boundAccount?.sessionId ?? null;
}

/**
 * The bound account's `User`, resolved from `usersById`. `null` when there is no
 * state, no bound account, or the bound account id is absent from `usersById`.
 *
 * A pinned user is resolved from `usersById` alone — deliberately NOT gated on
 * device membership — so a transient device-state gap cannot flicker the
 * identity vault's rendered user. Whether the pinned session still exists on the
 * device is answered by {@link activeSessionIdOf}.
 */
export function activeUserOf(
  state: DeviceSessionState | null,
  usersById: Map<string, User>,
  pinnedAccountId?: string | null,
): User | null {
  if (state === null) {
    return null;
  }
  const boundAccountId = boundAccountIdOf(state, pinnedAccountId);
  if (boundAccountId === null) {
    return null;
  }
  return usersById.get(boundAccountId) ?? null;
}

/**
 * All account ids in `state`, suitable for an `oxyServices.getUsersByIds(...)`
 * fetch. `[]` for `null` state.
 */
export function accountIdsOf(state: DeviceSessionState | null): string[] {
  if (state === null) {
    return [];
  }
  return state.accounts.map((account) => account.accountId);
}
