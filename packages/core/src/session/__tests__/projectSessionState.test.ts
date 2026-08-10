/**
 * `DeviceSessionState` projections, with and without an identity pin.
 *
 * Without a pin the projections resolve the device's `activeAccountId` exactly
 * as they always have. With one they resolve the PINNED account, so an account
 * switch made by another app on the same device changes `state` but never the
 * user an identity-bound client renders.
 */
import type { DeviceSessionState } from '@oxyhq/contracts';
import type { User } from '../../models/interfaces';
import {
  accountIdsOf,
  activeSessionIdOf,
  activeUserOf,
  deviceStateToClientSessions,
} from '../projectSessionState';

const PINNED = 'vault-user';
const OTHER = 'other-user';

const STATE: DeviceSessionState = {
  deviceId: 'dev-1',
  accounts: [
    { accountId: PINNED, sessionId: 'sess-vault', authuser: 0 },
    { accountId: OTHER, sessionId: 'sess-other', authuser: 1 },
  ],
  // Another app switched the device away from the pinned account.
  activeAccountId: OTHER,
  revision: 4,
  updatedAt: 1_720_000_000_000,
};

const user = (id: string): User => ({ id, username: id, name: {} });
const USERS = new Map<string, User>([
  [PINNED, user(PINNED)],
  [OTHER, user(OTHER)],
]);

describe('projections — unpinned (unchanged behaviour)', () => {
  it('resolves the device active account', () => {
    expect(activeSessionIdOf(STATE)).toBe('sess-other');
    expect(activeUserOf(STATE, USERS)?.id).toBe(OTHER);
    expect(deviceStateToClientSessions(STATE, USERS).map((s) => s.isCurrent)).toEqual([false, true]);
  });

  it('returns null for a null state or no active account', () => {
    expect(activeSessionIdOf(null)).toBeNull();
    expect(activeUserOf(null, USERS)).toBeNull();
    expect(activeSessionIdOf({ ...STATE, activeAccountId: null })).toBeNull();
    expect(activeUserOf({ ...STATE, activeAccountId: null }, USERS)).toBeNull();
    expect(accountIdsOf(null)).toEqual([]);
  });

  it('treats an empty-string pin as "not pinned"', () => {
    expect(activeSessionIdOf(STATE, '')).toBe('sess-other');
    expect(activeUserOf(STATE, USERS, '')?.id).toBe(OTHER);
  });
});

describe('projections — pinned', () => {
  it('resolves the PINNED account, not the device active one', () => {
    expect(activeSessionIdOf(STATE, PINNED)).toBe('sess-vault');
    expect(activeUserOf(STATE, USERS, PINNED)?.id).toBe(PINNED);
  });

  it('marks the pinned account as `isCurrent` so the session list cannot disagree', () => {
    expect(deviceStateToClientSessions(STATE, USERS, PINNED).map((s) => s.isCurrent)).toEqual([
      true,
      false,
    ]);
  });

  it('reports NO session id when the pinned account is absent from the device', () => {
    const withoutPinned: DeviceSessionState = {
      ...STATE,
      accounts: [{ accountId: OTHER, sessionId: 'sess-other', authuser: 0 }],
    };
    // The honest signal the caller answers by re-establishing the identity
    // session — never by silently adopting `other-user`.
    expect(activeSessionIdOf(withoutPinned, PINNED)).toBeNull();
    // The rendered user does not flicker to the other account while that happens.
    expect(activeUserOf(withoutPinned, USERS, PINNED)?.id).toBe(PINNED);
  });

  it('still enumerates every account id (profile hydration is unaffected)', () => {
    expect(accountIdsOf(STATE)).toEqual([PINNED, OTHER]);
  });
});

describe('the operator behind a delegated session', () => {
  it('carries operatedByUserId through instead of dropping it', () => {
    const operated: DeviceSessionState = {
      ...STATE,
      accounts: [
        { accountId: PINNED, sessionId: 'sess-vault', authuser: 0 },
        { accountId: OTHER, sessionId: 'sess-other', authuser: 1, operatedByUserId: PINNED },
      ],
    };

    const sessions = deviceStateToClientSessions(operated, USERS);

    // The delegated row names the human behind it; the direct one has nobody.
    expect(sessions.map((session) => session.operatedByUserId)).toEqual([undefined, PINNED]);
  });
});
