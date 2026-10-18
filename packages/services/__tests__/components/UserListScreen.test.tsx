import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import UserListScreen from '../../src/ui/screens/UserListScreen';

const header = jest.fn();
const followers = jest.fn();
const following = jest.fn();
const service = { follows: { followers, following }, assets: { publicUrl: (v: string) => v } };
jest.mock('../../src/ui/hooks/useSurfaceHeader', () => ({
  useSurfaceHeader: (value: unknown) => header(value),
}));
jest.mock('../../src/ui/hooks/useI18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
jest.mock('../../src/ui/context/oxyRuntimeContext', () => ({
  useOxy: () => ({ oxyServices: service, user: null }),
}));
jest.mock('../../src/ui/components/FollowButton', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('@oxy.so/bloom/chat-people', () => ({
  ...jest.requireActual('@oxy.so/bloom'),
  ContactRow: ({ name, onPress }: any) => <button onClick={onPress}>{name}</button>,
}));
jest.mock('react-native', () => ({
  ...jest.requireActual('react-native'),
  RefreshControl: () => null,
  FlatList: ({ data, renderItem, ListEmptyComponent }: any) => (
    <div>
      {data.length ? (
        data.map((item: any) => (
          <React.Fragment key={item.id}>{renderItem({ item })}</React.Fragment>
        ))
      ) : (
        <ListEmptyComponent />
      )}
    </div>
  ),
}));
const person = (id: string, displayName: string) => ({ id, username: id, name: { displayName } });
beforeEach(() => {
  jest.clearAllMocks();
});

test('searches subsequent follower pages, clears the search and opens a profile', async () => {
  followers
    .mockResolvedValueOnce({ followers: [person('first', 'First Person')], hasMore: true })
    .mockResolvedValueOnce({ followers: [person('last', 'Last Match')], hasMore: false });
  const navigate = jest.fn();
  render(<UserListScreen userId="owner" mode="followers" navigate={navigate} />);
  await screen.findByText('First Person');
  expect(header.mock.lastCall[0].subtitle).toBe('userList.followersDescription');
  act(() => header.mock.lastCall[0].actions[0].onPress());
  fireEvent.change(screen.getByLabelText('userList.search'), { target: { value: 'last' } });
  await screen.findByText('Last Match');
  expect(followers).toHaveBeenLastCalledWith('owner', { limit: 20, offset: 1, sort: undefined });
  expect(screen.queryByText('First Person')).toBeNull();
  fireEvent.click(screen.getByText('Last Match'));
  expect(navigate).toHaveBeenCalledWith('Profile', { userId: 'last' });
  fireEvent.change(screen.getByLabelText('userList.search'), { target: { value: 'absent' } });
  expect(screen.getByText('userList.noSearchResults')).toBeTruthy();
  act(() => header.mock.lastCall[0].actions[0].onPress());
  expect(screen.queryByLabelText('userList.search')).toBeNull();
  expect(screen.getByText('First Person')).toBeTruthy();
});

test('uses the following endpoint and explanatory subtitle', async () => {
  following.mockResolvedValue({
    following: [person('followed', 'Followed Person')],
    hasMore: false,
  });
  render(<UserListScreen userId="owner" mode="following" />);
  await screen.findByText('Followed Person');
  expect(header.mock.lastCall[0].subtitle).toBe('userList.followingDescription');
  expect(followers).not.toHaveBeenCalled();
});
