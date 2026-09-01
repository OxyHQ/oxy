/**
 * The background credential's ORDERING and REVOCATION rules, which are the parts
 * that can leak one account's data to another or leave a live credential behind.
 *
 * The native store and the mint are exercised on a device (see the design note);
 * what is tested here is every decision JS makes about when to clear, when to
 * provision, and — most importantly — when NOT to write.
 */
const requireOptionalNativeModule = jest.fn();

jest.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: (...args: unknown[]) => requireOptionalNativeModule(...args),
}));

interface NativeCalls {
  order: string[];
  put: jest.Mock;
  clear: jest.Mock;
  peek: jest.Mock;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function fakeNative(peekValue: { accountId: string; expiresAt: number } | null): NativeCalls {
  const order: string[] = [];
  return {
    order,
    put: jest.fn(async () => {
      order.push('put');
      return true;
    }),
    clear: jest.fn(async () => {
      order.push('clear');
      return true;
    }),
    peek: jest.fn(async () => {
      order.push('peek');
      return peekValue;
    }),
  };
}

function fakeOxy(
  provision: jest.Mock,
  baseURL = 'https://api.oxy.so',
): Parameters<typeof import('../backgroundSession').syncBackgroundSession>[0]['oxyServices'] {
  return {
    provisionBackgroundCredential: provision,
    getBaseURL: () => baseURL,
  } as unknown as Parameters<
    typeof import('../backgroundSession').syncBackgroundSession
  >[0]['oxyServices'];
}

/**
 * Re-import the module per test: it memoises the resolved native module, which is
 * correct in production (one resolution per process) and must not leak between
 * cases here.
 *
 * `platform` is explicit because the react-native stub defaults `Platform.OS` to
 * `'web'`, where this feature is gated OFF by design. Every case therefore has to
 * say which platform it is describing — defaulting to `'android'` here, since that
 * is the only platform the feature ships on.
 */
async function loadModule(native: NativeCalls | null, platform: 'android' | 'web' = 'android') {
  jest.resetModules();
  requireOptionalNativeModule.mockClear();
  requireOptionalNativeModule.mockReturnValue(
    native ? { put: native.put, clear: native.clear, peek: native.peek } : null,
  );
  const { Platform } = await import('react-native');
  Platform.OS = platform;
  return import('../backgroundSession');
}

function provisioned(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    deviceId: 'device-1',
    secret: 'bg-secret',
    accountId: 'user-1',
    expiresAt: new Date(Date.now() + 30 * DAY_MS).toISOString(),
    ...overrides,
  };
}

describe('syncBackgroundSession', () => {
  test('signed out clears the credential and never calls the network', async () => {
    const native = fakeNative({ accountId: 'user-1', expiresAt: Date.now() + 30 * DAY_MS });
    const { syncBackgroundSession } = await loadModule(native);
    const provision = jest.fn();

    await syncBackgroundSession({
      oxyServices: fakeOxy(provision),
      userId: null,
      canUsePrivateApi: true,
      isCurrent: () => true,
    });

    expect(native.clear).toHaveBeenCalledTimes(1);
    expect(provision).not.toHaveBeenCalled();
    // Not even a read: signing out must not depend on anything succeeding first.
    expect(native.peek).not.toHaveBeenCalled();
  });

  test('a credential for a DIFFERENT account is cleared BEFORE any network call', async () => {
    const native = fakeNative({ accountId: 'previous-user', expiresAt: Date.now() + 30 * DAY_MS });
    const { syncBackgroundSession } = await loadModule(native);
    const provision = jest.fn(async () => {
      native.order.push('provision');
      return provisioned();
    });

    await syncBackgroundSession({
      oxyServices: fakeOxy(provision),
      userId: 'user-1',
      canUsePrivateApi: true,
      isCurrent: () => true,
    });

    // The ordering IS the guarantee: a crash after the clear leaves background
    // code signed out, never serving the previous account's data.
    expect(native.order).toEqual(['peek', 'clear', 'provision', 'put']);
  });

  test('a healthy credential for the signed-in account makes no network call', async () => {
    const native = fakeNative({ accountId: 'user-1', expiresAt: Date.now() + 30 * DAY_MS });
    const { syncBackgroundSession } = await loadModule(native);
    const provision = jest.fn();

    await syncBackgroundSession({
      oxyServices: fakeOxy(provision),
      userId: 'user-1',
      canUsePrivateApi: true,
      isCurrent: () => true,
    });

    expect(provision).not.toHaveBeenCalled();
    expect(native.clear).not.toHaveBeenCalled();
    expect(native.put).not.toHaveBeenCalled();
  });

  test('renews a credential inside the renewal window', async () => {
    const native = fakeNative({ accountId: 'user-1', expiresAt: Date.now() + 2 * DAY_MS });
    const { syncBackgroundSession } = await loadModule(native);
    const expiresAt = new Date(Date.now() + 30 * DAY_MS).toISOString();
    const provision = jest.fn(async () => provisioned({ expiresAt }));

    await syncBackgroundSession({
      oxyServices: fakeOxy(provision),
      userId: 'user-1',
      canUsePrivateApi: true,
      isCurrent: () => true,
    });

    expect(provision).toHaveBeenCalledTimes(1);
    // Positional scalars, and the ORDER is the contract: the native signature is
    // five parameters, not one object, because an Expo Modules `Record` does not
    // convert in a consumer build of this package and every call was rejected. A
    // silently reordered argument would store a credential that no mint can use, so
    // this assertion is what pins the order — see `OxyBackgroundSessionModule.kt`.
    expect(native.put).toHaveBeenCalledWith(
      'https://api.oxy.so',
      'device-1',
      'bg-secret',
      'user-1',
      Date.parse(expiresAt),
    );
    // Same account, so nothing was revoked on the way.
    expect(native.clear).not.toHaveBeenCalled();
  });

  test('waits for a bearer instead of provisioning without one', async () => {
    const native = fakeNative(null);
    const { syncBackgroundSession } = await loadModule(native);
    const provision = jest.fn();

    await syncBackgroundSession({
      oxyServices: fakeOxy(provision),
      userId: 'user-1',
      canUsePrivateApi: false,
      isCurrent: () => true,
    });

    expect(provision).not.toHaveBeenCalled();
    expect(native.put).not.toHaveBeenCalled();
  });

  test('a not-yet-deployed endpoint (null) is quiet and writes nothing', async () => {
    const native = fakeNative(null);
    const { syncBackgroundSession } = await loadModule(native);
    const provision = jest.fn(async () => null);

    await syncBackgroundSession({
      oxyServices: fakeOxy(provision),
      userId: 'user-1',
      canUsePrivateApi: true,
      isCurrent: () => true,
    });

    expect(provision).toHaveBeenCalledTimes(1);
    expect(native.put).not.toHaveBeenCalled();
    expect(native.clear).not.toHaveBeenCalled();
  });

  test('a credential minted for another account mid-flight is dropped, not stored', async () => {
    const native = fakeNative(null);
    const { syncBackgroundSession } = await loadModule(native);
    // The active account moved while the request was in flight, so the server
    // answered for someone other than the account this run is syncing.
    const provision = jest.fn(async () => provisioned({ accountId: 'other-user' }));

    await syncBackgroundSession({
      oxyServices: fakeOxy(provision),
      userId: 'user-1',
      canUsePrivateApi: true,
      isCurrent: () => true,
    });

    expect(native.put).not.toHaveBeenCalled();
    expect(native.clear).toHaveBeenCalledTimes(1);
  });

  test('a superseded run does not write the credential it fetched', async () => {
    const native = fakeNative(null);
    const { syncBackgroundSession } = await loadModule(native);
    const provision = jest.fn(async () => provisioned());

    await syncBackgroundSession({
      oxyServices: fakeOxy(provision),
      userId: 'user-1',
      canUsePrivateApi: true,
      // Superseded while the request was in flight (unmount, or a newer run).
      isCurrent: () => false,
    });

    expect(native.put).not.toHaveBeenCalled();
  });

  test('an unparseable expiry is rejected rather than stored as garbage', async () => {
    const native = fakeNative(null);
    const { syncBackgroundSession } = await loadModule(native);
    const provision = jest.fn(async () => provisioned({ expiresAt: 'not-a-date' }));

    await syncBackgroundSession({
      oxyServices: fakeOxy(provision),
      userId: 'user-1',
      canUsePrivateApi: true,
      isCurrent: () => true,
    });

    expect(native.put).not.toHaveBeenCalled();
  });

  test('a provisioning failure never escapes to the caller', async () => {
    const native = fakeNative(null);
    const { syncBackgroundSession } = await loadModule(native);
    const provision = jest.fn(async () => {
      throw new Error('network down');
    });

    await expect(
      syncBackgroundSession({
        oxyServices: fakeOxy(provision),
        userId: 'user-1',
        canUsePrivateApi: true,
        isCurrent: () => true,
      }),
    ).resolves.toBeUndefined();
    expect(native.put).not.toHaveBeenCalled();
  });
});

describe('a @oxyhq/core too old to provision', () => {
  /**
   * The ONE failure that must not be quiet. Every other failure here is caught and
   * logged at warn, which is right for a flaky network — but a version skew means
   * background refreshes never work at all, and hiding that behind a warning is how
   * it would go unnoticed indefinitely.
   */
  function oxyWithoutProvisioning(): Parameters<
    typeof import('../backgroundSession').syncBackgroundSession
  >[0]['oxyServices'] {
    return { getBaseURL: () => 'https://api.oxy.so' } as unknown as Parameters<
      typeof import('../backgroundSession').syncBackgroundSession
    >[0]['oxyServices'];
  }

  test('rejects loudly and logs at error rather than warning quietly', async () => {
    const native = fakeNative(null);
    const { syncBackgroundSession } = await loadModule(native);
    const { logger } = await import('@oxyhq/core');
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    try {
      await expect(
        syncBackgroundSession({
          oxyServices: oxyWithoutProvisioning(),
          userId: 'user-1',
          canUsePrivateApi: true,
          isCurrent: () => true,
        }),
      ).rejects.toThrow(/provisionBackgroundCredential/);

      expect(errorSpy).toHaveBeenCalledTimes(1);
      // If this ever becomes a warn, the skew is silent again.
      expect(warnSpy).not.toHaveBeenCalled();
      expect(native.put).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  test('still lets a signed-out user clear, since that needs no core method', async () => {
    const native = fakeNative({ accountId: 'user-1', expiresAt: Date.now() + 30 * DAY_MS });
    const { syncBackgroundSession } = await loadModule(native);

    // A sign-out must never be blocked by a dependency problem.
    await expect(
      syncBackgroundSession({
        oxyServices: oxyWithoutProvisioning(),
        userId: null,
        canUsePrivateApi: false,
        isCurrent: () => true,
      }),
    ).resolves.toBeUndefined();
    expect(native.clear).toHaveBeenCalledTimes(1);
  });
});

describe('on web', () => {
  /**
   * Web must never provision. The credential is non-rotating and long-lived, which
   * is only safe because native background code is its sole consumer; a browser
   * origin already holds the ROTATING deviceSecret and has no background worker, so
   * a successful provision there is a security DOWNGRADE. The harm lands at the
   * network call, which mints a live server-side credential, so "storage failed
   * anyway" is not a defence.
   *
   * These tests present a native module that IS available, which is the whole
   * point: they fail if the gate ever relies on `requireOptionalNativeModule`
   * returning null on web rather than on the platform check.
   */
  test('does not provision even when a native module IS present', async () => {
    const native = fakeNative(null);
    const { syncBackgroundSession, isBackgroundSessionSupported } = await loadModule(native, 'web');
    const provision = jest.fn(async () => provisioned());

    expect(isBackgroundSessionSupported()).toBe(false);
    await syncBackgroundSession({
      oxyServices: fakeOxy(provision),
      userId: 'user-1',
      canUsePrivateApi: true,
      isCurrent: () => true,
    });

    expect(provision).not.toHaveBeenCalled();
    expect(native.put).not.toHaveBeenCalled();
    // Not even a read, so nothing in a browser origin is touched at all.
    expect(native.peek).not.toHaveBeenCalled();
    expect(native.clear).not.toHaveBeenCalled();
  });

  test('never asks the native registry on web', async () => {
    const { isBackgroundSessionSupported } = await loadModule(fakeNative(null), 'web');
    expect(isBackgroundSessionSupported()).toBe(false);
    // The platform decides BEFORE the registry is consulted, so a web-build
    // native-module mock or a future web shim cannot reopen the gate.
    expect(requireOptionalNativeModule).not.toHaveBeenCalled();
  });
});

describe('without the native module', () => {
  test('every entry point is an inert no-op', async () => {
    const { syncBackgroundSession, clearBackgroundSession, isBackgroundSessionSupported } =
      await loadModule(null);
    const provision = jest.fn();

    expect(isBackgroundSessionSupported()).toBe(false);
    await expect(clearBackgroundSession()).resolves.toBeUndefined();
    await expect(
      syncBackgroundSession({
        oxyServices: fakeOxy(provision),
        userId: 'user-1',
        canUsePrivateApi: true,
        isCurrent: () => true,
      }),
    ).resolves.toBeUndefined();
    expect(provision).not.toHaveBeenCalled();
  });
});
