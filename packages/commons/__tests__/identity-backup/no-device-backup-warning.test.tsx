/**
 * The warning Commons shows when the identity cannot have a device backup
 * (OxyHQ/oxy#1388): Android without Google Play services, where Block Store
 * rejects with SERVICE_INVALID, or a binary built without the native module.
 * There, a sibling app's "Clear storage" erases the identity and only the
 * recovery phrase brings it back.
 */
import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';
import { KeyManager } from '@oxy.so/core/crypto';
import { __resetAsyncStorage, __seedAsyncStorage } from '@/__mocks__/async-storage';
import { __getMockRouter } from '@/__mocks__/expo-router';
import { LocaleProvider } from '@/lib/i18n/locale-context';
import {
  isBlockStoreUnavailableError,
  probeDeviceBackupAvailability,
  IDENTITY_BACKUP_KEY,
} from '@/lib/identity-backup';
import {
  deriveDeviceBackupWarning,
  NO_DEVICE_BACKUP_ACKNOWLEDGED_KEY,
  NO_DEVICE_BACKUP_PROMPTED_KEY,
  type DeviceBackupWarningSnapshot,
} from '@/hooks/identity/useDeviceBackupWarning';
import { DeviceBackupWarning } from '@/components/identity/DeviceBackupWarning';

const requireOptional = requireOptionalNativeModule as jest.Mock;

/** What the LineageOS Pixel without GMS logged for the backfill write. */
function serviceInvalid(): Error {
  return Object.assign(
    new Error(
      '17: API: Blockstore.API is not available on this device. Connection failed with: a{statusCode=SERVICE_INVALID, resolution=null, message=null}',
    ),
    { code: 'ERR_IDENTITY_BACKUP_READ' },
  );
}

function nativeThatRejects(error: Error) {
  return {
    read: jest.fn(async () => {
      throw error;
    }),
    write: jest.fn(async () => {
      throw error;
    }),
    clear: jest.fn(async () => {
      throw error;
    }),
  };
}

function nativeThatWorks() {
  return {
    read: jest.fn(async () => null),
    write: jest.fn(async () => true),
    clear: jest.fn(async () => undefined),
  };
}

const KEY_A = '02'.padEnd(66, 'a');
const KEY_B = '03'.padEnd(66, 'b');
const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

beforeEach(() => {
  requireOptional.mockReset();
  Platform.OS = 'android';
  __resetAsyncStorage();
  __getMockRouter().push.mockReset();
});

describe('probeDeviceBackupAvailability', () => {
  it('is not-applicable off Android, without touching the native module', async () => {
    Platform.OS = 'ios';
    expect(await probeDeviceBackupAvailability()).toBe('not-applicable');
    expect(requireOptional).not.toHaveBeenCalled();
  });

  it('is unavailable on a binary built without the native module', async () => {
    requireOptional.mockReturnValue(null);
    expect(await probeDeviceBackupAvailability()).toBe('unavailable');
  });

  it('is available when Block Store answers the read', async () => {
    const native = nativeThatWorks();
    requireOptional.mockReturnValue(native);
    expect(await probeDeviceBackupAvailability()).toBe('available');
    expect(native.read).toHaveBeenCalledWith(IDENTITY_BACKUP_KEY);
  });

  it('is unavailable when Block Store rejects with SERVICE_INVALID (no Google Play services)', async () => {
    requireOptional.mockReturnValue(nativeThatRejects(serviceInvalid()));
    expect(await probeDeviceBackupAvailability()).toBe('unavailable');
  });

  it('is unknown for any other failure, so a transient error never shows the warning', async () => {
    requireOptional.mockReturnValue(
      nativeThatRejects(Object.assign(new Error('7: NETWORK_ERROR'), { code: 'ERR_IDENTITY_BACKUP_READ' })),
    );
    expect(await probeDeviceBackupAvailability()).toBe('unknown');
  });
});

describe('isBlockStoreUnavailableError', () => {
  it.each([
    ['SERVICE_INVALID', serviceInvalid(), true],
    ['SERVICE_MISSING', new Error('ConnectionResult{statusCode=SERVICE_MISSING}'), true],
    ['API_UNAVAILABLE', new Error('17: API_UNAVAILABLE'), true],
    ['a timeout', new Error('15: TIMEOUT'), false],
    ['a non-error', 'SERVICE_INVALID', false],
    ['null', null, false],
  ])('%s → %s', (_label, error, expected) => {
    expect(isBlockStoreUnavailableError(error)).toBe(expected);
  });
});

describe('deriveDeviceBackupWarning', () => {
  const base: DeviceBackupWarningSnapshot = {
    availability: 'unavailable',
    publicKey: KEY_A,
    hasPhrase: true,
    promptedFor: null,
    acknowledgedFor: null,
  };

  it('shows both banners for a fresh identity on a device without a device backup', () => {
    expect(deriveDeviceBackupWarning(base)).toEqual({ showBanner: true, showPrompt: true });
  });

  it('keeps the Settings banner after the one-time prompt was seen', () => {
    expect(deriveDeviceBackupWarning({ ...base, promptedFor: KEY_A })).toEqual({
      showBanner: true,
      showPrompt: false,
    });
  });

  it('hides both once the user confirmed for this key', () => {
    expect(deriveDeviceBackupWarning({ ...base, promptedFor: KEY_A, acknowledgedFor: KEY_A })).toEqual({
      showBanner: false,
      showPrompt: false,
    });
  });

  it('comes back after a key rotation: the old phrase no longer restores anything', () => {
    expect(
      deriveDeviceBackupWarning({ ...base, publicKey: KEY_B, promptedFor: KEY_A, acknowledgedFor: KEY_A }),
    ).toEqual({ showBanner: true, showPrompt: true });
  });

  it.each(['available', 'not-applicable', 'unknown'] as const)('is hidden when availability is %s', (availability) => {
    expect(deriveDeviceBackupWarning({ ...base, availability })).toEqual({ showBanner: false, showPrompt: false });
  });

  it('is hidden without an identity, or before the probe answered', () => {
    expect(deriveDeviceBackupWarning({ ...base, publicKey: null })).toEqual({ showBanner: false, showPrompt: false });
    expect(deriveDeviceBackupWarning(undefined)).toEqual({ showBanner: false, showPrompt: false });
  });
});

describe('<DeviceBackupWarning />', () => {
  let publicKey: string | null;
  let mnemonic: string | null;

  beforeEach(() => {
    publicKey = KEY_A;
    mnemonic = PHRASE;
    jest.spyOn(KeyManager, 'getPublicKey').mockImplementation(async () => publicKey);
    jest.spyOn(KeyManager, 'getRecoveryMnemonic').mockImplementation(async () => mnemonic);
  });

  function renderWarning(variant: 'prompt' | 'settings') {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <LocaleProvider>
          <DeviceBackupWarning variant={variant} />
        </LocaleProvider>
      </QueryClientProvider>,
    );
  }

  it('warns once after onboarding and retires the prompt on "Not now"', async () => {
    requireOptional.mockReturnValue(nativeThatRejects(serviceInvalid()));
    const first = renderWarning('prompt');
    await first.findByText("This identity isn't backed up on this device");

    await act(async () => {
      fireEvent.click(first.getByText('Not now'));
    });
    await waitFor(() => expect(first.queryByTestId('device-backup-warning-prompt')).toBeNull());
    first.unmount();

    // The next launch: no prompt on the ID tab, but Settings still warns.
    const again = renderWarning('prompt');
    const settings = renderWarning('settings');
    await settings.findByTestId('device-backup-warning-settings');
    expect(again.queryByTestId('device-backup-warning-prompt')).toBeNull();
  });

  it('offers the recovery phrase and the encrypted backup', async () => {
    requireOptional.mockReturnValue(nativeThatRejects(serviceInvalid()));
    const view = renderWarning('prompt');
    const router = __getMockRouter();

    fireEvent.click(await view.findByText('Write down your recovery phrase'));
    expect(router.push).toHaveBeenLastCalledWith('/(tabs)/(settings)/recovery-phrase');

    // Acting on the prompt retires it, like "Not now".
    await waitFor(() => expect(view.queryByTestId('device-backup-warning-prompt')).toBeNull());

    const settings = renderWarning('settings');
    fireEvent.click(await settings.findByText('Set up an encrypted backup'));
    expect(router.push).toHaveBeenLastCalledWith('/(tabs)/(settings)/create-backup');
    // Settings keeps the banner: only the confirmation retires it.
    expect(settings.getByTestId('device-backup-warning-settings')).toBeTruthy();
  });

  it('stays in Settings until the user confirms, and the confirmation persists for the key', async () => {
    requireOptional.mockReturnValue(nativeThatRejects(serviceInvalid()));
    __seedAsyncStorage(NO_DEVICE_BACKUP_PROMPTED_KEY, KEY_A);
    const settings = renderWarning('settings');

    await act(async () => {
      fireEvent.click(await settings.findByText("I've saved my recovery phrase"));
    });
    await waitFor(() => expect(settings.queryByTestId('device-backup-warning-settings')).toBeNull());
    settings.unmount();

    const later = renderWarning('settings');
    await waitFor(() => expect(KeyManager.getPublicKey).toHaveBeenCalled());
    expect(later.queryByTestId('device-backup-warning-settings')).toBeNull();
  });

  it('sends an identity without a phrase to key rotation', async () => {
    requireOptional.mockReturnValue(nativeThatRejects(serviceInvalid()));
    mnemonic = null;
    const view = renderWarning('settings');

    fireEvent.click(await view.findByText('Rotate to a key with a recovery phrase'));
    expect(__getMockRouter().push).toHaveBeenLastCalledWith('/(tabs)/(settings)/rotate-key');
    expect(view.queryByText('Write down your recovery phrase')).toBeNull();
  });

  it('shows nothing where Block Store works', async () => {
    const native = nativeThatWorks();
    requireOptional.mockReturnValue(native);
    const view = renderWarning('settings');
    await waitFor(() => expect(native.read).toHaveBeenCalled());
    expect(view.queryByTestId('device-backup-warning-settings')).toBeNull();
  });

  it('shows nothing on iOS and never probes there', async () => {
    Platform.OS = 'ios';
    const view = renderWarning('settings');
    await act(async () => undefined);
    expect(view.queryByTestId('device-backup-warning-settings')).toBeNull();
    expect(requireOptional).not.toHaveBeenCalled();
  });

  it('does not re-warn a key the user already confirmed', async () => {
    requireOptional.mockReturnValue(nativeThatRejects(serviceInvalid()));
    __seedAsyncStorage(NO_DEVICE_BACKUP_ACKNOWLEDGED_KEY, KEY_A);
    __seedAsyncStorage(NO_DEVICE_BACKUP_PROMPTED_KEY, KEY_A);
    const view = renderWarning('prompt');
    await waitFor(() => expect(KeyManager.getRecoveryMnemonic).toHaveBeenCalled());
    expect(view.queryByTestId('device-backup-warning-prompt')).toBeNull();
  });
});
