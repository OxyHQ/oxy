import {
  getStoreInstaller,
  setStoreInstaller,
  StoreInstallerError,
  type StoreInstaller,
  type StoreUpdates,
} from '../../index';

function fakeInstaller(): StoreInstaller {
  const updates: StoreUpdates = {
    updates: [],
    checking: false,
    lastChecked: null,
    checkFailed: false,
  };
  return {
    status: async (slugs) =>
      Object.fromEntries(slugs.map((slug) => [slug, { state: 'notInstalled' as const }])),
    install: async () => 'installed',
    update: async () => 'updated',
    uninstall: async () => 'removed',
    open: async () => undefined,
    subscribe: () => () => undefined,
    updates: {
      current: () => updates,
      read: async () => updates,
      check: async () => updates,
      apply: async () => undefined,
      applyAll: async () => undefined,
      subscribe: () => () => undefined,
    },
  };
}

describe('the store installer seam', () => {
  afterEach(() => setStoreInstaller(null));

  it('has no installer where no runtime registered one', () => {
    expect(getStoreInstaller()).toBeNull();
  });

  it('gives the installer a runtime registered, and none once it is removed', async () => {
    const installer = fakeInstaller();
    setStoreInstaller(installer);
    expect(getStoreInstaller()).toBe(installer);
    await expect(getStoreInstaller()?.status(['mention'])).resolves.toEqual({
      mention: { state: 'notInstalled' },
    });
    setStoreInstaller(null);
    expect(getStoreInstaller()).toBeNull();
  });

  it('says why a request failed and whether the machine already told the person', () => {
    const told = new StoreInstallerError('serviceUnavailable', { told: true });
    expect(told).toBeInstanceOf(Error);
    expect(told.name).toBe('StoreInstallerError');
    expect(told.reason).toBe('serviceUnavailable');
    expect(told.told).toBe(true);
    const untold = new StoreInstallerError('failed', { message: 'the download failed' });
    expect(untold.told).toBe(false);
    expect(untold.message).toBe('the download failed');
  });
});
