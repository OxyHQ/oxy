import { ExperimentalContextBarrier } from '../experimentalContextBarrier';

const credential = { deviceId: 'device', deviceSecret: 'secret' };
const bearer = 'nate-bearer';
const binding = {
  version: 1,
  deviceId: 'device',
  deviceSessionId: 'incarnation',
  revision: 2,
  contextId: 'context-nate',
  actorId: 'nate',
  accountId: 'org',
  sessionId: 'session-nate',
  accessToken: bearer,
  expiresAt: '2099-01-01T00:00:00.000Z',
};
const state = {
  deviceId: 'device',
  revision: 2,
  updatedAt: 1,
  activeAccountId: 'org',
  accounts: [
    { accountId: 'org', sessionId: 'session-alice', authuser: 0, operatedByUserId: 'alice' },
    { accountId: 'org', sessionId: 'session-nate', authuser: 1, operatedByUserId: 'nate' },
  ],
};
const directory = {
  deviceId: 'device',
  revision: 2,
  updatedAt: 1,
  activeContextId: 'context-nate',
  principals: [
    {
      id: 'p-nate',
      userId: 'nate',
      authuser: 1,
      user: { id: 'nate', username: 'nate' },
      contexts: [
        {
          id: 'context-nate',
          accountId: 'org',
          kind: 'organization',
          relationship: 'member',
          account: { id: 'org', username: 'org' },
          onDevice: true,
          available: true,
          active: true,
          lastUsedAt: null,
        },
      ],
    },
  ],
};

function fixture() {
  let token: string | null = 'alice-bearer';
  let heldCredential = credential;
  let listener = () => {};
  const io = {
    getCredential: () => heldCredential,
    getAccessToken: () => token,
    setAccessToken: (next: string) => {
      token = next;
      listener();
    },
    mint: jest.fn(async () => binding as unknown),
    readState: jest.fn(async () => state as unknown),
    readDirectory: jest.fn(async () => directory as unknown),
  };
  const gate = new ExperimentalContextBarrier(io);
  return {
    gate,
    io,
    listen: (fn: () => void) => {
      listener = fn;
    },
    token: () => token,
    replaceCredential: (next: typeof credential) => {
      heldCredential = next;
    },
  };
}

describe('experimental staged context barrier', () => {
  it('stays closed through token-listener reentry', async () => {
    const f = fixture();
    expect(await f.gate.reconcile()).toBe(true);
    const prior = f.gate.lease();
    f.gate.invalidate();
    expect(f.gate.snapshot()).toBeNull();
    expect(f.gate.isCurrent(prior)).toBe(false);
    f.listen(() => {
      expect(f.gate.snapshot()).toBeNull();
      expect(() => f.gate.lease()).toThrow();
    });
    expect(await f.gate.reconcile()).toBe(true);
    expect(f.gate.snapshot()?.actorId).toBe('nate');
    expect(f.token()).toBe(bearer);
  });

  it('rejects a mismatched actor or session, including duplicate subject rows', async () => {
    const f = fixture();
    f.io.mint.mockResolvedValueOnce({ ...binding, sessionId: 'session-alice' });
    expect(await f.gate.reconcile()).toBe(false);
    expect(f.gate.snapshot()).toBeNull();
    expect(f.token()).toBe('alice-bearer');
  });

  it('does not reopen if a synchronous token listener invalidates it again', async () => {
    const f = fixture();
    f.listen(() => f.gate.invalidate());
    expect(await f.gate.reconcile()).toBe(false);
    expect(f.gate.snapshot()).toBeNull();
  });

  it('does not commit a delayed prior request after an ABA signal', async () => {
    const f = fixture();
    let finish!: (value: unknown) => void;
    f.io.mint.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const old = f.gate.reconcile();
    f.gate.invalidate();
    f.gate.invalidate();
    expect(await f.gate.reconcile()).toBe(true);
    finish(binding);
    expect(await old).toBe(false);
    expect(f.gate.snapshot()?.actorId).toBe('nate');
  });

  it('refuses a response if the holder credential was replaced during mint', async () => {
    const f = fixture();
    let finish!: (value: unknown) => void;
    f.io.mint.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = f.gate.reconcile();
    f.replaceCredential({ ...credential, deviceSecret: 'replacement' });
    finish(binding);
    expect(await pending).toBe(false);
    expect(f.gate.status()).toBe('unavailable');
    expect(f.token()).toBe('alice-bearer');
  });

  it('does not reopen when state or directory disagree with the issued revision', async () => {
    const f = fixture();
    f.io.readDirectory.mockResolvedValueOnce({ ...directory, revision: 3 });
    expect(await f.gate.reconcile()).toBe(false);
    expect(f.gate.snapshot()).toBeNull();
    expect(f.token()).toBe('alice-bearer');
  });

  it('rejects a matching but older revision for the same device incarnation', async () => {
    const f = fixture();
    expect(await f.gate.reconcile()).toBe(true);
    f.io.mint.mockResolvedValueOnce({ ...binding, revision: 1 });
    f.io.readState.mockResolvedValueOnce({ ...state, revision: 1 });
    f.io.readDirectory.mockResolvedValueOnce({ ...directory, revision: 1 });
    expect(await f.gate.reconcile()).toBe(false);
    expect(f.gate.snapshot()).toBeNull();
  });

  it.each(['invalid', '2000-01-01T00:00:00Z'])('refuses expiry %s', async (expiresAt) => {
    const f = fixture();
    f.io.mint.mockResolvedValueOnce({ ...binding, expiresAt });
    expect(await f.gate.reconcile()).toBe(false);
    expect(f.token()).toBe('alice-bearer');
  });

  it('returns a deeply frozen staged snapshot', async () => {
    const f = fixture();
    expect(await f.gate.reconcile()).toBe(true);
    const snapshot = f.gate.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot?.directory.principals[0].contexts[0])).toBe(true);
  });

  it.each([401, 409, 429, 500])('does not downgrade when mint fails with %s', async (status) => {
    const f = fixture();
    f.io.mint.mockRejectedValueOnce(new Error(String(status)));
    expect(await f.gate.reconcile()).toBe(false);
    expect(f.gate.snapshot()).toBeNull();
    expect(f.token()).toBe('alice-bearer');
  });
});
