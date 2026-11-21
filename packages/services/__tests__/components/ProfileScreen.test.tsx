import type { ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { DataProvider, Store, withStore } from '@oxy.so/bloom-data';
import { ProfileCard } from '../../src/ui/data/account';
import ProfileScreen from '../../src/ui/screens/ProfileScreen';

/** The screen in a fresh account store, as the session gives it. */
function inStore(ui: ReactNode, store = new Store()) {
  return render(<DataProvider store={store}>{ui}</DataProvider>);
}

const header = jest.fn();
const profileGet = jest.fn(() => new Promise(() => {}));
jest.mock('../../src/ui/hooks/useSurfaceHeader', () => ({
  useSurfaceHeader: (value: unknown) => header(value),
}));
jest.mock('../../src/ui/hooks/useFollow', () => ({
  useFollow: () => ({ followerCount: 3, followingCount: 2, isLoadingCounts: false }),
}));
jest.mock('../../src/ui/components/FollowButton', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('../../src/ui/hooks/useI18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
jest.mock('../../src/ui/context/oxyRuntimeContext', () => ({
  useOxy: () => ({
    user: { id: 'owner', username: 'sample', name: { displayName: 'Sample Person' } },
    oxyServices: {
      users: { get: (...args: unknown[]) => profileGet(...args) },
      reputation: { balance: () => Promise.resolve({ total: 2 }) },
    },
  }),
}));

test('shows the known owner immediately with standard dialog chrome and routes Edit Profile to the editor', () => {
  const navigate = jest.fn();
  inStore(<ProfileScreen userId="owner" navigate={navigate} />);
  expect(screen.getByText('Sample Person')).toBeTruthy();
  expect(screen.queryByTestId('profile-skeleton')).toBeNull();
  expect(screen.getByTestId('profile-cover-header')).toBeTruthy();
  expect(header).toHaveBeenLastCalledWith({ title: 'Sample Person', largeTitle: false });
  fireEvent.click(screen.getByRole('button', { name: 'editProfile.title' }));
  expect(navigate).toHaveBeenCalledWith('EditProfile');
  fireEvent.click(screen.getByRole('button', { name: 'accountMenu.settings' }));
  expect(navigate).toHaveBeenCalledWith('Preferences');
  fireEvent.click(screen.getByRole('button', { name: '3 profile.followers' }));
  expect(navigate).toHaveBeenCalledWith('FollowersList', { userId: 'owner', initialCount: 3 });
  fireEvent.click(screen.getByRole('button', { name: '2 profile.following' }));
  expect(navigate).toHaveBeenCalledWith('FollowingList', { userId: 'owner', initialCount: 2 });
  expect(screen.queryByText('profile.noBio')).toBeNull();
});

test('shows a Bloom skeleton only until an uncached profile arrives', async () => {
  let resolveProfile!: (value: unknown) => void;
  profileGet.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveProfile = resolve;
      }),
  );
  inStore(<ProfileScreen userId="other" />);
  expect(screen.getByTestId('profile-skeleton')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '3 profile.followers' })).toBeNull();
  await act(async () =>
    resolveProfile({ id: 'other', username: 'other', name: { displayName: 'Other Person' } }),
  );
  await screen.findByText('Other Person');
  expect(screen.queryByTestId('profile-skeleton')).toBeNull();
});

test('shows a cached profile immediately while refreshing it', () => {
  const store = new Store();
  withStore(store, () =>
    ProfileCard.put({
      id: 'cached',
      profile: { id: 'cached', username: 'cached', name: { displayName: 'Cached Person' } },
      reputationTotal: 2,
    } as never),
  );
  inStore(<ProfileScreen userId="cached" />, store);
  expect(screen.getByText('Cached Person')).toBeTruthy();
  expect(screen.queryByTestId('profile-skeleton')).toBeNull();
});
