import type { DeviceDirectory, DeviceSessionState } from '@oxyhq/contracts';
import type { User } from '@oxyhq/core';
import { createOxyRuntime, type OxyRuntime } from '../../src/ui/runtime';

export interface TestRuntimeOptions {
  getAccessToken?: () => string | null;
  getUsersByIds?: (ids: string[]) => Promise<User[]>;
  getState?: () => DeviceSessionState | null;
  getDirectory?: () => DeviceDirectory | null;
  onDeviceEmpty?: () => Promise<void>;
}

/**
 * A real `OxyRuntime` over inert seams, for suites that need somewhere for the
 * session facts to live but are not testing the device projection.
 *
 * Deliberately the REAL runtime rather than a mock: these suites assert what a
 * caller can observe (the snapshot, the auth-store projection), and a mock of
 * the object under everything would only assert that the test's own stub was
 * called.
 */
export function createTestRuntime(options: TestRuntimeOptions = {}): OxyRuntime {
  return createOxyRuntime({
    oxyServices: {
      getAccessToken: options.getAccessToken ?? (() => null),
      getUsersByIds: options.getUsersByIds ?? (async () => []),
    },
    sessionClient: {
      getState: options.getState ?? (() => null),
      getDirectory: options.getDirectory ?? (() => null),
      subscribe: () => () => undefined,
      refreshDirectory: async () => undefined,
    },
    sessionClientHost: { setCurrentAccountId: () => undefined },
    identity: null,
    onDeviceEmpty: options.onDeviceEmpty ?? (async () => undefined),
    logger: () => undefined,
  });
}
