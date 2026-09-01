import {
  deviceAccountContextSchema,
  deviceActivateRequestSchema,
  deviceActivateResponseSchema,
  deviceDirectorySchema,
  deviceDirectorySyncSchema,
  devicePrincipalSchema,
  deviceSessionSyncSchema,
  safeParseContract,
} from '../index';

const natePersonal = {
  id: 'ctx_nate_personal',
  accountId: 'nate',
  kind: 'personal' as const,
  relationship: 'self' as const,
  account: { id: 'nate', username: 'nate' },
  onDevice: true,
  available: true,
  active: false,
  lastUsedAt: 1720000000000,
};

const nateOxy = {
  id: 'ctx_nate_oxy',
  accountId: 'oxy_collective',
  kind: 'organization' as const,
  relationship: 'owner' as const,
  account: { id: 'oxy_collective', username: 'oxy' },
  onDevice: true,
  available: true,
  active: true,
  lastUsedAt: 1720000001000,
};

const aliceOxy = {
  ...nateOxy,
  id: 'ctx_alice_oxy',
  relationship: 'member' as const,
  active: false,
};

const nate = {
  id: 'principal_nate',
  userId: 'nate',
  authuser: 0,
  user: { id: 'nate', username: 'nate' },
  contexts: [natePersonal, nateOxy],
};

const alice = {
  id: 'principal_alice',
  userId: 'alice',
  authuser: 1,
  user: { id: 'alice', username: 'alice' },
  contexts: [
    { ...natePersonal, id: 'ctx_alice_personal', accountId: 'alice', account: { id: 'alice', username: 'alice' } },
    aliceOxy,
  ],
};

const directory = {
  deviceId: 'device_x',
  revision: 42,
  activeContextId: 'ctx_nate_oxy',
  principals: [nate, alice],
  updatedAt: 1720000002000,
};

describe('deviceDirectorySchema', () => {
  it('parses a two-principal directory', () => {
    expect(safeParseContract(deviceDirectorySchema, directory)).toEqual(directory);
  });

  it('carries the same account under two principals as two distinct contexts', () => {
    const parsed = safeParseContract(deviceDirectorySchema, directory);
    const contexts = parsed?.principals.flatMap((p) => p.contexts) ?? [];
    const oxy = contexts.filter((c) => c.accountId === 'oxy_collective');
    // The shape this whole model exists for: one account id, two context ids.
    expect(oxy).toHaveLength(2);
    expect(new Set(oxy.map((c) => c.id)).size).toBe(2);
  });

  it('accepts activeContextId=null (no active context on this device)', () => {
    const parsed = safeParseContract(deviceDirectorySchema, { ...directory, activeContextId: null });
    expect(parsed?.activeContextId).toBeNull();
  });

  it('rejects a negative authuser', () => {
    expect(safeParseContract(devicePrincipalSchema, { ...nate, authuser: -1 })).toBeNull();
  });

  it('rejects a non-integer authuser', () => {
    expect(safeParseContract(devicePrincipalSchema, { ...nate, authuser: 1.5 })).toBeNull();
  });

  it('rejects a directory missing revision', () => {
    const { revision, ...noRevision } = directory;
    expect(safeParseContract(deviceDirectorySchema, noRevision)).toBeNull();
  });

  it('rejects an unknown account kind', () => {
    expect(safeParseContract(deviceAccountContextSchema, { ...nateOxy, kind: 'team' })).toBeNull();
  });

  it('rejects an unknown relationship', () => {
    expect(safeParseContract(deviceAccountContextSchema, { ...nateOxy, relationship: 'admin' })).toBeNull();
  });

  it('accepts a reachable-but-unused context (onDevice=false)', () => {
    const parsed = safeParseContract(deviceAccountContextSchema, {
      ...nateOxy,
      onDevice: false,
      active: false,
      lastUsedAt: null,
    });
    expect(parsed?.onDevice).toBe(false);
    expect(parsed?.lastUsedAt).toBeNull();
  });

  it('accepts a revoked-membership context as available=false rather than omitting it', () => {
    const parsed = safeParseContract(deviceAccountContextSchema, { ...nateOxy, available: false, active: false });
    expect(parsed?.available).toBe(false);
  });

  it('keeps displayName optional on a directory profile', () => {
    const parsed = safeParseContract(devicePrincipalSchema, {
      ...nate,
      user: { id: 'nate', username: 'nate', name: { first: 'Nate' } },
    });
    expect(parsed?.user.name?.displayName).toBeUndefined();
  });

  it('rejects a profile without an id', () => {
    expect(safeParseContract(devicePrincipalSchema, { ...nate, user: { username: 'nate' } })).toBeNull();
  });

  /**
   * The accent survives the parse (issue #961).
   *
   * A zod object STRIPS unknown keys, so a schema that does not declare `color`
   * does not reject a payload carrying one — it silently drops it, and the row
   * renders in the ambient theme accent with nothing anywhere saying why. This
   * asserts the value on the far side of the parse for that reason.
   */
  it('carries the accent each row is drawn in, per account', () => {
    const parsed = safeParseContract(deviceDirectorySchema, {
      ...directory,
      principals: [
        {
          ...nate,
          user: { id: 'nate', username: 'nate', color: 'purple' },
          contexts: [
            { ...natePersonal, account: { id: 'nate', username: 'nate', color: 'purple' } },
            { ...nateOxy, account: { id: 'oxy_collective', username: 'oxy', color: 'amber' } },
          ],
        },
      ],
    });

    expect(parsed?.principals[0].user.color).toBe('purple');
    // Two accounts under ONE person, drawn in two different accents — the case
    // a single ambient theme accent cannot represent.
    expect(parsed?.principals[0].contexts.map((context) => context.account.color)).toEqual([
      'purple',
      'amber',
    ]);
  });

  it('accepts a profile with no colour at all, and an explicitly null one', () => {
    expect(safeParseContract(devicePrincipalSchema, nate)?.user.color).toBeUndefined();
    expect(
      safeParseContract(devicePrincipalSchema, {
        ...nate,
        user: { id: 'nate', username: 'nate', color: null },
      })?.user.color
    ).toBeNull();
  });

  it('rejects a colour that is not a string', () => {
    expect(
      safeParseContract(devicePrincipalSchema, {
        ...nate,
        user: { id: 'nate', username: 'nate', color: { preset: 'purple' } },
      })
    ).toBeNull();
  });
});

describe('device activation contracts', () => {
  it('parses an activate request', () => {
    expect(safeParseContract(deviceActivateRequestSchema, { contextId: 'ctx_nate_oxy' })).toEqual({
      contextId: 'ctx_nate_oxy',
    });
  });

  it('rejects an empty contextId', () => {
    expect(safeParseContract(deviceActivateRequestSchema, { contextId: '' })).toBeNull();
  });

  it('rejects an accountId in place of a contextId', () => {
    // An account id cannot name a context on a multi-principal device.
    expect(safeParseContract(deviceActivateRequestSchema, { accountId: 'oxy_collective' })).toBeNull();
  });

  it('parses a response carrying directory + token', () => {
    const response = {
      directory,
      activeToken: { accessToken: 'tok', expiresAt: '2026-08-10T10:00:00.000Z' },
    };
    expect(safeParseContract(deviceActivateResponseSchema, response)).toEqual(response);
  });

  it('accepts activeToken=null (identity-pinned or non-entitled caller)', () => {
    const parsed = safeParseContract(deviceActivateResponseSchema, { directory, activeToken: null });
    expect(parsed?.activeToken).toBeNull();
  });

  it('rejects a response with no activeToken key at all', () => {
    expect(safeParseContract(deviceActivateResponseSchema, { directory })).toBeNull();
  });
});

describe('deviceDirectorySyncSchema — the context-aware removal response', () => {
  const state = {
    deviceId: 'device_x',
    accounts: [{ accountId: 'nate', sessionId: 'sess_nate', authuser: 0 }],
    activeAccountId: 'nate',
    revision: 43,
    updatedAt: 1720000003000,
  };
  const removal = {
    directory,
    state,
    activeToken: { accessToken: 'tok', expiresAt: '2026-08-10T10:00:00.000Z' },
  };

  it('parses both halves plus the token', () => {
    expect(safeParseContract(deviceDirectorySyncSchema, removal)).toEqual(removal);
  });

  it('accepts activeToken=null, including "the removal left no active context"', () => {
    expect(safeParseContract(deviceDirectorySyncSchema, { ...removal, activeToken: null })?.activeToken).toBeNull();
  });

  /**
   * The reason this is a SECOND schema rather than a widened first one.
   *
   * Zod strips unknown keys, so the removal response parses cleanly as a
   * `deviceSessionSync` — silently dropping the directory. That direction is
   * lossy and gives no signal, which is why the removal lane must never be
   * routed through `applySync`. The reverse direction is the one that has to
   * fail, and does: `directory` is required, so a directory-less payload is
   * refused instead of being read as "this device has no principals".
   */
  it('is not interchangeable with deviceSessionSyncSchema', () => {
    expect(safeParseContract(deviceSessionSyncSchema, removal)).toEqual({
      state,
      activeToken: removal.activeToken,
    });
    expect(safeParseContract(deviceDirectorySyncSchema, { state, activeToken: removal.activeToken })).toBeNull();
  });

  it('rejects a payload missing the flat state', () => {
    expect(safeParseContract(deviceDirectorySyncSchema, { directory, activeToken: null })).toBeNull();
  });
});
