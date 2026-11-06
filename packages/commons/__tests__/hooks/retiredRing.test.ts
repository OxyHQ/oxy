import type { OxyServices } from '@oxy.so/core';
import {
  claimRetiredIdentityKeys,
  syncRetiredKeys,
  unmirrorPersonalRetiredKeys,
} from '@oxy.so/core/crypto';
import { reconcileRetiredRing } from '@/hooks/identity/retiredRing';

jest.mock('@oxy.so/core/crypto', () => ({
  claimRetiredIdentityKeys: jest.fn().mockResolvedValue(0),
  syncRetiredKeys: jest.fn().mockResolvedValue(0),
  unmirrorPersonalRetiredKeys: jest.fn().mockResolvedValue(undefined),
}));

function client(keyHistory: jest.Mock): OxyServices {
  return { identity: { keyHistory } } as unknown as OxyServices;
}

describe('retired ring session ownership', () => {
  beforeEach(() => jest.clearAllMocks());

  it('ignores delayed history from the previous account and reconciles the new account', async () => {
    let release = () => {};
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    let owner = 'A';
    const historyA = jest.fn(async () => {
      await delayed;
      return { publicKey: 'A-key', retired: [] };
    });
    const first = reconcileRetiredRing(client(historyA), 'A', () => owner === 'A');
    await Promise.resolve();
    expect(historyA).toHaveBeenCalledTimes(1);
    owner = 'B';
    const second = reconcileRetiredRing(
      client(jest.fn().mockResolvedValue({ publicKey: 'B-key', retired: [] })),
      'B',
      () => owner === 'B',
    );
    release();
    await Promise.all([first, second]);
    expect(claimRetiredIdentityKeys).toHaveBeenCalledTimes(1);
    expect(claimRetiredIdentityKeys).toHaveBeenCalledWith('B', ['B-key']);
    expect(syncRetiredKeys).toHaveBeenCalledWith('B');
    expect(syncRetiredKeys).toHaveBeenCalledTimes(1);
  });

  it('clears an in-flight native mirror on logout before allowing another account', async () => {
    let release = () => {};
    let started = () => {};
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    jest.mocked(syncRetiredKeys).mockImplementationOnce(async () => {
      started();
      await delayed;
      return 1;
    });
    let current = true;
    const first = reconcileRetiredRing(
      client(jest.fn().mockResolvedValue({ publicKey: 'A-key', retired: [] })),
      'A',
      () => current,
    );
    await entered;
    current = false;
    const second = reconcileRetiredRing(
      client(jest.fn().mockResolvedValue({ publicKey: 'B-key', retired: [] })),
      'B',
      () => true,
    );
    release();
    await Promise.all([first, second]);
    expect(unmirrorPersonalRetiredKeys).toHaveBeenCalledTimes(1);
    expect(jest.mocked(unmirrorPersonalRetiredKeys).mock.invocationCallOrder[0]).toBeLessThan(
      jest.mocked(syncRetiredKeys).mock.invocationCallOrder[1],
    );
  });

  it('a failed check does not suppress a later sign-in retry', async () => {
    await expect(
      reconcileRetiredRing(
        client(jest.fn().mockRejectedValue(new Error('offline'))),
        'A',
        () => true,
      ),
    ).rejects.toThrow('offline');
    await reconcileRetiredRing(
      client(jest.fn().mockResolvedValue({ publicKey: 'A-key', retired: [] })),
      'A',
      () => true,
    );
    expect(syncRetiredKeys).toHaveBeenCalledWith('A');
  });
});
