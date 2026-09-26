import type { User } from '@oxy.so/core';
import { logger } from '@oxy.so/core';
import {
  commitDeviceSetAndResolve,
  type CommitDeviceSetAndResolveDeps,
} from '../commitSessionFlow';

// A resolved promise chain (addCurrentAccount -> start -> syncFromClient) settles
// entirely within the microtask queue, which is fully drained before a macrotask
// (`setTimeout`) runs — so one tick flushes a detached reconcile task.
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const makeUser = (id: string): User => ({ id, username: id } as unknown as User);

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

const deferred = <T,>(): Deferred<T> => {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/**
 * Build a deps object whose every step appends to a shared `order` log, so tests
 * can assert both WHICH steps ran and the RELATIVE ordering between the
 * auth-resolution gate and the device-set reconcile.
 */
const buildDeps = (
  order: string[],
  overrides: Partial<CommitDeviceSetAndResolveDeps> = {},
): CommitDeviceSetAndResolveDeps => ({
  activate: false,
  userId: 'u1',
  fallbackUser: makeUser('fallback'),
  registerAndActivate: jest.fn(async () => {
    order.push('registerAndActivate');
  }),
  addCurrentAccount: jest.fn(async () => {
    order.push('addCurrentAccount');
  }),
  startSocket: jest.fn(async () => {
    order.push('startSocket');
  }),
  syncFromClient: jest.fn(async () => {
    order.push('syncFromClient');
  }),
  getCurrentUser: jest.fn(async () => {
    order.push('getCurrentUser');
    return makeUser('u1');
  }),
  loginSuccess: jest.fn(() => {
    order.push('loginSuccess');
  }),
  onAuthStateChange: jest.fn(() => {
    order.push('onAuthStateChange');
  }),
  markAuthResolved: jest.fn(() => {
    order.push('markAuthResolved');
  }),
  ...overrides,
});

describe('commitDeviceSetAndResolve — cold boot (activate: false)', () => {
  it('does not re-register when the mint already returned authoritative device state', async () => {
    const order: string[] = [];
    const deps = buildDeps(order, { hasDeviceState: true });

    await commitDeviceSetAndResolve(deps);
    await flush();

    expect(deps.addCurrentAccount).not.toHaveBeenCalled();
    expect(deps.startSocket).toHaveBeenCalledTimes(1);
    expect(deps.syncFromClient).toHaveBeenCalledTimes(1);
  });

  it('resolves auth from getCurrentUser BEFORE the device-set reconcile', async () => {
    const order: string[] = [];
    const deps = buildDeps(order);

    await commitDeviceSetAndResolve(deps);
    await flush();

    // loginSuccess + onAuthStateChange + markAuthResolved fire after getCurrentUser.
    expect(deps.loginSuccess).toHaveBeenCalledWith(makeUser('u1'));
    expect(deps.onAuthStateChange).toHaveBeenCalledWith(makeUser('u1'));
    expect(deps.markAuthResolved).toHaveBeenCalledTimes(1);

    expect(order.indexOf('getCurrentUser')).toBeLessThan(order.indexOf('loginSuccess'));
    expect(order.indexOf('loginSuccess')).toBeLessThan(order.indexOf('markAuthResolved'));

    // The reconcile ran (via addCurrentAccount, NOT registerAndActivate) but only
    // AFTER the auth gate flipped — proving it did not block the resolve.
    expect(deps.addCurrentAccount).toHaveBeenCalledTimes(1);
    expect(deps.registerAndActivate).not.toHaveBeenCalled();
    expect(order.indexOf('markAuthResolved')).toBeLessThan(order.indexOf('addCurrentAccount'));
    expect(order.indexOf('addCurrentAccount')).toBeLessThan(order.indexOf('startSocket'));
    expect(order.indexOf('startSocket')).toBeLessThan(order.indexOf('syncFromClient'));
  });

  it('still resolves auth even when the device-set reconcile hangs forever', async () => {
    const order: string[] = [];
    const hang = deferred<void>(); // addCurrentAccount never settles
    const deps = buildDeps(order, {
      addCurrentAccount: jest.fn(() => {
        order.push('addCurrentAccount');
        return hang.promise;
      }),
    });

    // Must resolve without waiting on the hung reconcile.
    await commitDeviceSetAndResolve(deps);

    expect(deps.markAuthResolved).toHaveBeenCalledTimes(1);
    expect(deps.loginSuccess).toHaveBeenCalledWith(makeUser('u1'));
    expect(deps.addCurrentAccount).toHaveBeenCalledTimes(1);
    // The hung step gates the rest of the chain — never reached.
    expect(deps.startSocket).not.toHaveBeenCalled();
    expect(deps.syncFromClient).not.toHaveBeenCalled();
  });

  it('falls back to the minimal commit-input user when the profile fetch fails', async () => {
    const order: string[] = [];
    const deps = buildDeps(order, {
      getCurrentUser: jest.fn(async () => {
        throw new Error('offline');
      }),
    });

    await commitDeviceSetAndResolve(deps);
    await flush();

    expect(deps.loginSuccess).toHaveBeenCalledWith(makeUser('fallback'));
    expect(deps.markAuthResolved).toHaveBeenCalledTimes(1);
  });

  it('falls back to the minimal commit-input user when getCurrentUser returns null', async () => {
    const order: string[] = [];
    const deps = buildDeps(order, {
      getCurrentUser: jest.fn(async () => null),
    });

    await commitDeviceSetAndResolve(deps);
    await flush();

    expect(deps.loginSuccess).toHaveBeenCalledWith(makeUser('fallback'));
    expect(deps.markAuthResolved).toHaveBeenCalledTimes(1);
  });

  it('logs (never swallows) a failing background reconcile and still resolves', async () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const order: string[] = [];
    const failure = new Error('device-set boom');
    const deps = buildDeps(order, {
      addCurrentAccount: jest.fn(async () => {
        throw failure;
      }),
    });

    await commitDeviceSetAndResolve(deps);
    await flush();

    expect(deps.markAuthResolved).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      'commitSession: device-set registration failed',
      { component: 'OxyContext', method: 'commitSession' },
      failure,
    );
  });

  it('downgrades a 401 reconcile (signed-out edge) to debug — never warns', async () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const debugSpy = jest.spyOn(logger, 'debug').mockImplementation(() => undefined);
    const order: string[] = [];
    // A stale/cleared bearer 401s `POST /session/device/add`: the EXPECTED
    // signed-out outcome, not a failure the user should see warned in the console.
    const unauthorized = Object.assign(new Error('Invalid or missing authorization header'), {
      status: 401,
    });
    const deps = buildDeps(order, {
      addCurrentAccount: jest.fn(async () => {
        throw unauthorized;
      }),
    });

    await commitDeviceSetAndResolve(deps);
    await flush();

    expect(deps.markAuthResolved).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledWith(
      'commitSession: device-set registration skipped (signed out)',
      { component: 'OxyContext', method: 'commitSession' },
      unauthorized,
    );
  });
});

describe('commitDeviceSetAndResolve — deliberate sign-in (activate: true)', () => {
  it('BLOCKS on the device-set reconcile before resolving auth (unchanged ordering)', async () => {
    const order: string[] = [];
    const gate = deferred<void>(); // registerAndActivate stays pending
    const deps = buildDeps(order, {
      activate: true,
      registerAndActivate: jest.fn(() => {
        order.push('registerAndActivate');
        return gate.promise;
      }),
    });

    const settled = jest.fn();
    const pending = commitDeviceSetAndResolve(deps).then(settled);

    // While the reconcile is pending, auth must NOT resolve yet.
    await flush();
    expect(deps.registerAndActivate).toHaveBeenCalledTimes(1);
    expect(deps.addCurrentAccount).not.toHaveBeenCalled();
    expect(deps.getCurrentUser).not.toHaveBeenCalled();
    expect(deps.markAuthResolved).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();

    // Complete the reconcile → hydrate + resolve now runs.
    gate.resolve();
    await pending;

    expect(order).toEqual([
      'registerAndActivate',
      'startSocket',
      'syncFromClient',
      'getCurrentUser',
      'loginSuccess',
      'onAuthStateChange',
      'markAuthResolved',
    ]);
    expect(settled).toHaveBeenCalledTimes(1);
  });
});
