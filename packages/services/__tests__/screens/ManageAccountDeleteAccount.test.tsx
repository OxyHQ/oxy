/**
 * `ManageAccountScreen` — "Delete account" on native, OxyHQ/Mention#1169.
 *
 * Signed in to an app whose identity key is kept by Oxy Commons on the same
 * device, "Delete account" used to open the in-app confirmation and fail inside
 * it ("No identity found on this device…"). The screen now asks where the key
 * is first: the app's own deletion runs only when the app holds it; otherwise
 * it hands off to Commons' delete-account screen, or explains where to go, and
 * never calls the deletion API. An account WITHOUT a key is deleted with a code
 * by email, in the `DeleteAccount` panel.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';

const deleteAccount = jest.fn();
const hasIdentity = jest.fn<Promise<boolean>, []>();
const logout = jest.fn();
let user: { id: string; username: string; publicKey?: string } = { id: 'u1', username: 'nate', publicKey: '04ab' };

jest.mock('../../src/ui/context/OxyContext', () => ({
  __esModule: true,
  useOxy: () => ({
    user,
    isAuthenticated: true,
    oxyServices: {
      users: { deleteMe: (...a: unknown[]) => deleteAccount(...a) },
      assets: { publicUrl: () => undefined },
    },
    activeSessionId: 's1',
    logout,
    openAvatarPicker: jest.fn(),
    accounts: [],
    openAccountDialog: jest.fn(),
    hasIdentity: () => hasIdentity(),
  }),
}));

jest.mock('../../src/ui/hooks/useI18n', () => ({
  __esModule: true,
  useI18n: () => ({ t: (key: string) => `[${key}]`, locale: 'en-US' }),
}));

jest.mock('../../src/ui/hooks/useSurfaceHeader', () => ({
  __esModule: true,
  useSurfaceHeader: jest.fn(),
}));

jest.mock('../../src/ui/hooks/queries/useAccountQueries', () => ({
  __esModule: true,
  useCurrentUser: () => ({ data: user, isLoading: false }),
}));
jest.mock('../../src/ui/hooks/queries/usePaymentQueries', () => ({
  __esModule: true,
  useUserSubscription: () => ({ data: null }),
}));
jest.mock('../../src/ui/hooks/queries/useServicesQueries', () => ({
  __esModule: true,
  useDeviceSessions: () => ({ data: [], isLoading: false, refetch: jest.fn() }),
}));

// jsdom is a browser; these cases are the native branch.
jest.mock('../../src/ui/utils/isWebBrowser', () => ({
  __esModule: true,
  isWebBrowser: () => false,
}));

jest.mock('../../src/ui/components/SettingsIcon', () => ({
  __esModule: true,
  SettingsIcon: () => null,
  default: () => null,
}));
jest.mock('../../src/ui/components/ProfileSummaryCard', () => ({
  __esModule: true,
  default: () => null,
}));

const presentDeleteAccount = jest.fn();
jest.mock('../../src/ui/components/modals/DeleteAccountModal', () => ({
  __esModule: true,
  presentDeleteAccount: (...a: unknown[]) => presentDeleteAccount(...a),
}));

import { Linking } from 'react-native';
import { surfaces } from '@oxy.so/bloom';
import ManageAccountScreen from '../../src/ui/screens/ManageAccountScreen';

const confirm = surfaces.confirm as unknown as jest.Mock;

const navigate = jest.fn();
const pressDeleteAccount = async () => {
  render(<ManageAccountScreen onClose={jest.fn()} navigate={navigate} />);
  await act(async () => {
    fireEvent.click(
      screen.getByText('[accountOverview.items.deleteAccount.title]').closest('button') as HTMLButtonElement,
    );
  });
};

let canOpenURL: jest.SpyInstance;
let openURL: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  user = { id: 'u1', username: 'nate', publicKey: '04ab' };
  canOpenURL = jest.spyOn(Linking, 'canOpenURL');
  openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  presentDeleteAccount.mockResolvedValue(false);
});

afterEach(() => {
  canOpenURL.mockRestore();
  openURL.mockRestore();
});

describe('ManageAccountScreen: Delete account', () => {
  it('opens the email-code panel for an account without a key', async () => {
    user = { id: 'u1', username: 'nate' };

    await pressDeleteAccount();

    expect(navigate).toHaveBeenCalledWith('DeleteAccount');
    expect(hasIdentity).not.toHaveBeenCalled();
    expect(presentDeleteAccount).not.toHaveBeenCalled();
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it('opens Commons at its delete-account screen when Commons holds the identity', async () => {
    hasIdentity.mockResolvedValue(false);
    canOpenURL.mockResolvedValue(true);
    confirm.mockResolvedValue(true);

    await pressDeleteAccount();

    expect(canOpenURL).toHaveBeenCalledWith('oxycommons://');
    expect(openURL).toHaveBeenCalledWith('oxycommons://delete-account');
    expect(presentDeleteAccount).not.toHaveBeenCalled();
    expect(deleteAccount).not.toHaveBeenCalled();
    expect(logout).not.toHaveBeenCalled();
  });

  it('explains where to delete the account when Commons is not on this device', async () => {
    hasIdentity.mockResolvedValue(false);
    canOpenURL.mockResolvedValue(false);
    confirm.mockResolvedValue(true);

    await pressDeleteAccount();

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '[deleteAccount.handoff.elsewhereTitle]',
        hideCancel: true,
      }),
    );
    expect(openURL).not.toHaveBeenCalled();
    expect(presentDeleteAccount).not.toHaveBeenCalled();
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it("runs the app's own confirmation when the app holds the identity key", async () => {
    hasIdentity.mockResolvedValue(true);

    await pressDeleteAccount();

    expect(canOpenURL).not.toHaveBeenCalled();
    expect(presentDeleteAccount).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'nate' }),
    );
  });
});
