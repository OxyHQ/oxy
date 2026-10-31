import { QueryClient } from '@tanstack/react-query';
import { OxyServices } from '../../../core/src/OxyServices';
import { DeviceManager } from '../../../core/src/utils/deviceManager';
import { ExperimentalContextBarrier } from '../../../core/src/session/experimentalContextBarrier';
import { ExperimentalOwnedMutationRegistry } from '../../src/ui/hooks/experimentalOwnedMutationRegistry';
import { ExperimentalQuarantinedMutationCache } from '../../src/ui/hooks/experimentalQuarantinedMutationCache';
import { createExperimentalOwnedPersistence } from '../../src/ui/hooks/experimentalOwnedPersistence';
import { createExperimentalOwnedDeviceRename } from '../../src/ui/hooks/experimentalOwnedDeviceRename';

const jwt = (actor: string) =>
  `h.${Buffer.from(JSON.stringify({ userId: 'org', sessionId: `s-${actor}`, exp: 4102444800 })).toString('base64url')}.s`;

it('uses the bound session for a real Oxy device-rename consumer and fences a late response', async () => {
  const originalFetch = globalThis.fetch;
  let release!: (response: unknown) => void;
  let delay = false;
  const fetcher = jest.fn(async (_url: string, init: { body?: string }) => {
    const name = JSON.parse(init.body ?? '{}').deviceName;
    const response = {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ success: true, message: 'updated', deviceName: name }),
    };
    if (delay)
      return new Promise((resolve) => {
        release = resolve;
      });
    return response;
  });
  globalThis.fetch = fetcher as typeof fetch;
  const oxy = new OxyServices({ baseURL: 'https://oxy.invalid', enableRetry: false });
  oxy.http.setTokens(jwt('alice'));
  let actor = 'alice';
  const cache = new ExperimentalQuarantinedMutationCache();
  const queryClient = new QueryClient({ mutationCache: cache });
  const values = new Map<string, string>();
  const storage = {
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      values.set(key, value);
    },
  };
  let persistence!: ReturnType<typeof createExperimentalOwnedPersistence>;
  const gate = new ExperimentalContextBarrier({
    getCredential: () => ({ deviceId: 'device', deviceSecret: 'fixture-holder-secret' }),
    getAccessToken: () => oxy.http.experimentalPeekAccessToken(),
    setAccessToken: (token) => oxy.http.experimentalInstallContextToken(token),
    mint: async () => ({
      version: 1,
      deviceId: 'device',
      deviceSessionId: 'instance',
      revision: actor === 'alice' ? 1 : 2,
      contextId: `ctx-${actor}`,
      actorId: actor,
      accountId: 'org',
      sessionId: `s-${actor}`,
      accessToken: jwt(actor),
      expiresAt: '2099-01-01T00:00:00Z',
    }),
    readState: async () => ({
      deviceId: 'device',
      revision: actor === 'alice' ? 1 : 2,
      updatedAt: 1,
      activeAccountId: 'org',
      accounts: [
        { accountId: 'org', sessionId: 's-alice', authuser: 0, operatedByUserId: 'alice' },
        { accountId: 'org', sessionId: 's-nate', authuser: 1, operatedByUserId: 'nate' },
      ],
    }),
    readDirectory: async () => ({
      deviceId: 'device',
      revision: actor === 'alice' ? 1 : 2,
      updatedAt: 1,
      activeContextId: `ctx-${actor}`,
      principals: [
        {
          id: `p-${actor}`,
          userId: actor,
          authuser: 0,
          user: { id: actor, username: actor },
          contexts: [
            {
              id: `ctx-${actor}`,
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
    }),
    prepareCommit: (previous, next, current) => persistence.prepareCommit(previous, next, current),
  });
  oxy.experimentalSetContextGate(gate);
  const registry = new ExperimentalOwnedMutationRegistry(() => {
    const snapshot = gate.snapshot();
    if (!snapshot) return null;
    const value = gate.lease();
    return {
      owner: {
        actorId: snapshot.actorId,
        accountId: snapshot.accountId,
        sessionId: snapshot.sessionId,
      },
      isCurrent: () => gate.isCurrent(value),
      request: (request) => oxy.http.experimentalRequestForLease(request, gate, value),
    };
  });
  persistence = createExperimentalOwnedPersistence({ client: queryClient, storage, registry });
  const localUpdate = jest.spyOn(DeviceManager, 'updateDeviceName').mockResolvedValue();
  const rename = createExperimentalOwnedDeviceRename(registry, persistence.checkpoint, {
    updateLocalName: async (name, current) => {
      if (!current()) throw new Error('Mutation owner changed');
      await DeviceManager.updateDeviceName(name);
    },
  });
  try {
    expect(await gate.reconcile()).toBe(true);
    await oxy.devices.rename('s-alice', 'Alice desk');
    await rename.rename('op-alice', '  Alice desk  ');
    expect(fetcher.mock.calls[0][0]).toBe('https://oxy.invalid/session/device/name/s-alice');
    expect(fetcher.mock.calls[1][0]).toBe(fetcher.mock.calls[0][0]);
    expect(fetcher.mock.calls[1][1].method).toBe(fetcher.mock.calls[0][1].method);
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual(
      JSON.parse(fetcher.mock.calls[0][1].body),
    );
    expect(fetcher.mock.calls[1][1].headers.Authorization).toBe(`Bearer ${jwt('alice')}`);
    actor = 'nate';
    gate.invalidate();
    expect(await gate.reconcile()).toBe(true);
    await rename.rename('op-nate', 'Nate desk');
    expect(fetcher.mock.calls[2][0]).toBe('https://oxy.invalid/session/device/name/s-nate');
    expect(fetcher.mock.calls[2][1].headers.Authorization).toBe(`Bearer ${jwt('nate')}`);
    expect(localUpdate).toHaveBeenCalledTimes(2);
    for (const raw of values.values()) {
      expect(raw).not.toContain('fixture-holder-secret');
      expect(raw).not.toContain(jwt('alice'));
      expect(raw).not.toContain(jwt('nate'));
    }
    delay = true;
    const pending = rename.rename('op-late', 'Late');
    for (let i = 0; i < 50 && fetcher.mock.calls.length < 4; i++) await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(4);
    release({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => {
        gate.invalidate();
        return { success: true, deviceName: 'Late' };
      },
    });
    await expect(pending).rejects.toThrow();
    expect(localUpdate).toHaveBeenCalledTimes(2);

    // The real DeviceManager still has an internal async read/write gap.
    localUpdate.mockRestore();
    delay = false;
    expect(await gate.reconcile()).toBe(true);
    let resumeRead!: () => void;
    let readStarted!: () => void;
    const waiting = new Promise<void>((resolve) => {
      resumeRead = resolve;
    });
    const started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    const read = jest.spyOn(DeviceManager, 'getDeviceInfo').mockImplementation(async () => {
      readStarted();
      await waiting;
      return { deviceId: 'device', createdAt: 'now', lastUsed: 'now' };
    });
    const writes: string[] = [];
    const write = jest.spyOn(DeviceManager, 'saveDeviceInfo').mockImplementation(async (info) => {
      writes.push(info.deviceName ?? '');
    });
    try {
      const duringLocal = rename.rename('op-local', 'Old actor name');
      await started;
      gate.invalidate();
      resumeRead();
      await expect(duringLocal).rejects.toThrow();
      expect(writes).toEqual(['Old actor name']);
    } finally {
      read.mockRestore();
      write.mockRestore();
    }
  } finally {
    localUpdate.mockRestore();
    queryClient.clear();
    oxy.dispose();
    globalThis.fetch = originalFetch;
  }
});
