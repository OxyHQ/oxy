import { act, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ProfileScreen from '../../src/ui/screens/ProfileScreen';

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
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ProfileScreen userId="owner" navigate={navigate} />
    </QueryClientProvider>,
  );
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
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ProfileScreen userId="other" />
    </QueryClientProvider>,
  );
  expect(screen.getByTestId('profile-skeleton')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '3 profile.followers' })).toBeNull();
  await act(async () =>
    resolveProfile({ id: 'other', username: 'other', name: { displayName: 'Other Person' } }),
  );
  await screen.findByText('Other Person');
  expect(screen.queryByTestId('profile-skeleton')).toBeNull();
});

test('shows a cached profile immediately while refreshing it', () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['profileScreen', 'cached', 'owner'], {
    profile: { id: 'cached', username: 'cached', name: { displayName: 'Cached Person' } },
    reputationTotal: 2,
  });
  render(
    <QueryClientProvider client={client}>
      <ProfileScreen userId="cached" />
    </QueryClientProvider>,
  );
  expect(screen.getByText('Cached Person')).toBeTruthy();
  expect(screen.queryByTestId('profile-skeleton')).toBeNull();
});
