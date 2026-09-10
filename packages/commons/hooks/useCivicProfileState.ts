/**
 * Offline-first state machine for a civic profile surface (the Oxy ID card and
 * the scanned-card view).
 *
 * Three states, per the Commons offline guarantee:
 *
 *   - `pending`     — the user's own identity exists locally but is NOT yet
 *                     confirmed-synced to the server (created offline / first
 *                     run). The DID, key and QR still render from the local
 *                     identity; the screen shows a "pending registration" note.
 *   - `cache-first` — offline, so render the last-known (React Query–cached)
 *                     card plus an "offline" chip rather than a spinner.
 *   - `live`        — online; data is fresh / refetching in the background.
 *
 * `pending` only applies to the user's OWN identity (`subject: 'self'`); a
 * scanned remote card (`subject: 'remote'`) can only be `live` or `cache-first`.
 * The state is derived (no `useEffect`) from a pure function so every transition
 * is unit-testable without React.
 */

import { useOnlineStatus } from '@oxy.so/services';

/** The offline-first state of a civic profile surface. */
export type CivicProfileState = 'pending' | 'cache-first' | 'live';

/** Whose card a surface renders: the user's own Oxy ID, or a scanned remote card. */
export type CivicProfileSubject = 'self' | 'remote';

interface DeriveCivicProfileStateInput {
  subject: CivicProfileSubject;
  /** Whether the subject's local identity is confirmed-synced to the server.
   *  Only consulted for `subject: 'self'`. */
  isSynced: boolean;
  /** Whether the device currently has network connectivity. */
  isOnline: boolean;
}

/**
 * Pure derivation of the civic profile state. Exposed (and unit tested)
 * independently of the hook so all input combinations are covered without
 * standing up React / the online manager.
 */
export function deriveCivicProfileState(input: DeriveCivicProfileStateInput): CivicProfileState {
  // No confirmed server account yet — the local identity (DID/key/QR) still
  // renders, but there is nothing live to fetch. Remote cards are never pending.
  if (input.subject === 'self' && !input.isSynced) {
    return 'pending';
  }
  return input.isOnline ? 'live' : 'cache-first';
}

export interface UseCivicProfileStateInput {
  subject: CivicProfileSubject;
  /** For `subject: 'self'`: the local identity sync state (`isSynced`).
   *  Ignored for `subject: 'remote'`. Defaults to `false` (treated as pending)
   *  when omitted for a self surface. */
  isSynced?: boolean;
}

export interface UseCivicProfileStateResult {
  state: CivicProfileState;
  /** Live network connectivity — drives the "offline" chip. */
  isOnline: boolean;
}

/**
 * Resolve the offline-first state for a civic profile surface from the live
 * online status plus the caller-supplied sync signal.
 *
 * @param input - The surface subject and (for `self`) its sync state.
 */
export function useCivicProfileState(
  input: UseCivicProfileStateInput,
): UseCivicProfileStateResult {
  const isOnline = useOnlineStatus();
  const state = deriveCivicProfileState({
    subject: input.subject,
    isSynced: input.subject === 'self' ? input.isSynced ?? false : true,
    isOnline,
  });
  return { state, isOnline };
}
