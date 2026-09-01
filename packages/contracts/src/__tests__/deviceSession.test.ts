import {
  deviceSessionStateSchema,
  sessionAccountSchema,
  deviceSessionSyncSchema,
  deviceTokenMintRequestSchema,
  deviceTokenMintResponseSchema,
  deviceBackgroundCredentialResponseSchema,
  deviceBackgroundTokenRequestSchema,
  deviceBackgroundTokenResponseSchema,
  sessionAccountsChangedEventSchema,
  SESSION_ACCOUNTS_CHANGED_EVENT,
  safeParseContract,
} from '../index';

describe('deviceSessionStateSchema', () => {
  const account = { accountId: 'a1', sessionId: 's1', authuser: 0 };
  const state = { deviceId: 'd1', accounts: [account], activeAccountId: 'a1', revision: 3, updatedAt: 1720000000000 };

  it('parses a valid state', () => {
    expect(safeParseContract(deviceSessionStateSchema, state)).toEqual(state);
  });

  it('accepts an optional operatedByUserId on an account', () => {
    const withOp = { ...account, operatedByUserId: 'op1' };
    expect(safeParseContract(sessionAccountSchema, withOp)).toEqual(withOp);
  });

  it('accepts activeAccountId=null (device signed out of all)', () => {
    const parsed = safeParseContract(deviceSessionStateSchema, { ...state, accounts: [], activeAccountId: null });
    expect(parsed?.activeAccountId).toBeNull();
  });

  it('rejects a negative authuser', () => {
    expect(safeParseContract(sessionAccountSchema, { ...account, authuser: -1 })).toBeNull();
  });

  it('rejects a state missing revision', () => {
    const { revision, ...noRev } = state;
    expect(safeParseContract(deviceSessionStateSchema, noRev)).toBeNull();
  });
});

describe('deviceSessionSyncSchema', () => {
  const state = { deviceId: 'd1', accounts: [{ accountId: 'a1', sessionId: 's1', authuser: 0 }], activeAccountId: 'a1', revision: 1, updatedAt: 1720000000000 };
  it('parses { state, activeToken }', () => {
    const v = { state, activeToken: { accessToken: 'jwt', expiresAt: '2026-07-07T00:00:00.000Z' } };
    expect(safeParseContract(deviceSessionSyncSchema, v)).toEqual(v);
  });
  it('accepts activeToken=null', () => {
    expect(safeParseContract(deviceSessionSyncSchema, { state, activeToken: null })?.activeToken).toBeNull();
  });
  it('rejects a state-less sync', () => {
    expect(safeParseContract(deviceSessionSyncSchema, { activeToken: null })).toBeNull();
  });
});

describe('deviceTokenMintRequestSchema', () => {
  it('parses a valid { deviceId, deviceSecret }', () => {
    const v = { deviceId: 'd1', deviceSecret: 'secret_abc' };
    expect(safeParseContract(deviceTokenMintRequestSchema, v)).toEqual(v);
  });

  it('rejects a missing deviceSecret', () => {
    expect(safeParseContract(deviceTokenMintRequestSchema, { deviceId: 'd1' })).toBeNull();
  });

  it('rejects a missing deviceId', () => {
    expect(safeParseContract(deviceTokenMintRequestSchema, { deviceSecret: 's' })).toBeNull();
  });

  it('rejects an empty deviceId / deviceSecret', () => {
    expect(safeParseContract(deviceTokenMintRequestSchema, { deviceId: '', deviceSecret: 's' })).toBeNull();
    expect(safeParseContract(deviceTokenMintRequestSchema, { deviceId: 'd1', deviceSecret: '' })).toBeNull();
  });
});

describe('deviceTokenMintResponseSchema', () => {
  const state = { deviceId: 'd1', accounts: [{ accountId: 'a1', sessionId: 's1', authuser: 0 }], activeAccountId: 'a1', revision: 3, updatedAt: 1720000000000 };

  it('parses a valid mint response', () => {
    const v = { accessToken: 'jwt.access', expiresAt: '2026-07-07T00:00:00.000Z', nextDeviceSecret: 'next_secret', state };
    expect(safeParseContract(deviceTokenMintResponseSchema, v)).toEqual(v);
  });

  it('rejects a response missing nextDeviceSecret', () => {
    const v = { accessToken: 'jwt.access', expiresAt: '2026-07-07T00:00:00.000Z', state };
    expect(safeParseContract(deviceTokenMintResponseSchema, v)).toBeNull();
  });

  it('rejects a response with an invalid nested state', () => {
    const v = { accessToken: 'a', expiresAt: 'e', nextDeviceSecret: 'n', state: { deviceId: 'd1' } };
    expect(safeParseContract(deviceTokenMintResponseSchema, v)).toBeNull();
  });
});

describe('deviceBackgroundCredentialResponseSchema', () => {
  const credential = { deviceId: 'd1', secret: 'bg_secret', accountId: 'a1', expiresAt: '2026-10-07T00:00:00.000Z' };

  it('parses a valid provision response', () => {
    expect(safeParseContract(deviceBackgroundCredentialResponseSchema, credential)).toEqual(credential);
  });

  it('rejects a credential without an account to scope it to', () => {
    const { accountId, ...noAccount } = credential;
    expect(safeParseContract(deviceBackgroundCredentialResponseSchema, noAccount)).toBeNull();
  });

  it('rejects an empty secret', () => {
    expect(safeParseContract(deviceBackgroundCredentialResponseSchema, { ...credential, secret: '' })).toBeNull();
  });
});

describe('deviceBackgroundTokenRequestSchema', () => {
  it('parses a bearer-less { deviceId, secret }', () => {
    const v = { deviceId: 'd1', secret: 'bg_secret' };
    expect(safeParseContract(deviceBackgroundTokenRequestSchema, v)).toEqual(v);
  });

  it('rejects an empty deviceId / secret', () => {
    expect(safeParseContract(deviceBackgroundTokenRequestSchema, { deviceId: '', secret: 's' })).toBeNull();
    expect(safeParseContract(deviceBackgroundTokenRequestSchema, { deviceId: 'd1', secret: '' })).toBeNull();
  });

  it('never asks for a rotated secret back', () => {
    expect(Object.keys(deviceBackgroundTokenRequestSchema.shape)).toEqual(['deviceId', 'secret']);
  });
});

describe('deviceBackgroundTokenResponseSchema', () => {
  const response = { accessToken: 'jwt.access', expiresAt: '2026-07-07T00:00:00.000Z', accountId: 'a1' };

  it('parses a valid background token response', () => {
    expect(safeParseContract(deviceBackgroundTokenResponseSchema, response)).toEqual(response);
  });

  it('rejects a response without the account the token belongs to', () => {
    const { accountId, ...noAccount } = response;
    expect(safeParseContract(deviceBackgroundTokenResponseSchema, noAccount)).toBeNull();
  });

  it('carries no device state and no rotated secret', () => {
    expect(Object.keys(deviceBackgroundTokenResponseSchema.shape)).toEqual(['accessToken', 'expiresAt', 'accountId']);
    const parsed = safeParseContract(deviceBackgroundTokenResponseSchema, {
      ...response,
      accounts: [{ accountId: 'a1', sessionId: 's1', authuser: 0 }],
      activeAccountId: 'a1',
      revision: 3,
      nextDeviceSecret: 'next_secret',
    });
    expect(parsed).toEqual(response);
  });
});

describe('sessionAccountsChangedEventSchema', () => {
  it('parses a valid token-free signal', () => {
    const v = { userId: 'u1', revision: 4, reason: 'add' as const };
    expect(safeParseContract(sessionAccountsChangedEventSchema, v)).toEqual(v);
  });

  it('accepts every documented reason', () => {
    for (const reason of ['login', 'add', 'switch', 'signout', 'revoke'] as const) {
      expect(safeParseContract(sessionAccountsChangedEventSchema, { userId: 'u1', revision: 0, reason })).not.toBeNull();
    }
  });

  it('rejects an unknown reason', () => {
    expect(safeParseContract(sessionAccountsChangedEventSchema, { userId: 'u1', revision: 0, reason: 'nope' })).toBeNull();
  });

  it('rejects a negative revision', () => {
    expect(safeParseContract(sessionAccountsChangedEventSchema, { userId: 'u1', revision: -1, reason: 'add' })).toBeNull();
  });

  it('exposes the canonical event name', () => {
    expect(SESSION_ACCOUNTS_CHANGED_EVENT).toBe('session_accounts_changed');
  });
});
