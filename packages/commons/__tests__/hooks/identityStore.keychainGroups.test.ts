/**
 * The identity store's flags live in Commons' OWN keychain groups on iOS
 * (round-5 review R5-9): a value another Oxy app plants in the shared group —
 * `oxy_recovery_phrase_acknowledged = true`, which would silence the "write
 * down your phrase" warning — is never read.
 */

const ACCESS = {
  mode: 'grouped',
  prefix: 'ABCDE12345.',
  defaultGroup: 'ABCDE12345.so.oxy.identity',
  role: 'holder',
  appGroup: 'ABCDE12345.so.oxy.commons',
} as const;
const SHARED = 'ABCDE12345.group.so.oxy.shared';

jest.mock('@oxy.so/core/crypto', () => ({
  ...jest.requireActual('@oxy.so/core/crypto'),
  resolveKeychainAccess: async () => ACCESS,
}));

import {
  getRecoveryPhraseAcknowledgedFromStorage,
  persistRecoveryPhraseAcknowledged,
  RECOVERY_PHRASE_ACK_STORAGE_KEY,
} from '@/hooks/identity/identityStore';
import { __resetSecureStore, getItemAsync, setItemAsync } from '@/__mocks__/expo-secure-store';

describe('identityStore — iOS keychain groups', () => {
  beforeEach(() => {
    __resetSecureStore();
  });

  it('never honours a flag planted in the shared group, or read without a group', async () => {
    (getItemAsync as jest.Mock).mockImplementation(
      async (_key: string, options?: { accessGroup?: string }) =>
        options?.accessGroup === undefined || options.accessGroup === SHARED ? 'true' : null,
    );
    await expect(getRecoveryPhraseAcknowledgedFromStorage()).resolves.toBe(false);
    const groups = (getItemAsync as jest.Mock).mock.calls.map(
      ([, options]) => (options as { accessGroup?: string } | undefined)?.accessGroup,
    );
    expect(groups).toEqual([ACCESS.appGroup, ACCESS.defaultGroup]);
  });

  it('writes to Commons’ own application group', async () => {
    await persistRecoveryPhraseAcknowledged(true);
    expect(setItemAsync).toHaveBeenCalledWith(RECOVERY_PHRASE_ACK_STORAGE_KEY, 'true', {
      accessGroup: ACCESS.appGroup,
    });
  });
});
