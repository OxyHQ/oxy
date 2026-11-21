import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Store } from '@oxy.so/bloom-data';
import { dataWrapper, openTestStore } from '../helpers/dataStore';

const oxyServicesStub = {
  // Multi-user status resolution now goes through the batched bulk endpoint
  // (one call for all members) rather than N single `getFollowStatus` calls.
  follows: {
    statuses: jest.fn(async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, false]))),
    follow: jest.fn(),
    followMany: jest.fn(),
    unfollowMany: jest.fn(),
  },
  session: {
    get userId() {
      return jest.fn(() => 'me')();
    },
  },
};

let ctx = {
  oxyServices: oxyServicesStub,
  canUsePrivateApi: true,
  user: { id: 'me' },
};

jest.mock('../../src/ui/context/oxyRuntimeContext', () =>
  jest.requireMock('../../src/ui/context/oxyRuntimeContext'),
);

jest.mock('../../src/ui/context/oxyRuntimeContext', () => ({
  useOxy: () => ctx,
  useOptionalOxy: () => null,
}));

jest.mock('@oxy.so/core', () => ({
  ...jest.requireActual('@oxy.so/core'),
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

import FollowButton from '../../src/ui/components/FollowButton';
import { setFollowStatus } from '../../src/ui/data/follow';

let store: Store;
const renderWithStore = (children: ReactNode) => render(children, { wrapper: dataWrapper(store) });

describe('FollowButton multi-user initial state', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    store = openTestStore();
    ctx = { oxyServices: oxyServicesStub, canUsePrivateApi: true, user: { id: 'me' } };
  });

  it('does not render for an unauthenticated viewer or their own account', () => {
    ctx.canUsePrivateApi = false;
    const view = renderWithStore(<FollowButton userId="u1" initiallyFollowing={false} />);
    expect(screen.queryByRole('button')).toBeNull();
    view.unmount();
    ctx.canUsePrivateApi = true;
    renderWithStore(<FollowButton userId="me" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('keeps unknown status neutral and non-interactive until resolved', () => {
    renderWithStore(<FollowButton userId="unresolved" />);
    const button = screen.getByRole('button', { name: 'Follow' });
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.textContent).toBe('');
  });

  it('does not announce an unaccepted single-user mutation as a follow', async () => {
    const toggle = oxyServicesStub.follows.follow.mockRejectedValue(new Error('refused'));
    const onFollowChange = jest.fn();
    renderWithStore(
      <FollowButton userId="u1" initiallyFollowing={false} onFollowChange={onFollowChange} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Follow' }));
    await waitFor(() => expect(toggle).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Follow' })).toBeTruthy());
    expect(onFollowChange).not.toHaveBeenCalled();
  });

  it('honors initiallyAllFollowing before async status fetch populates the store', () => {
    renderWithStore(
      <FollowButton userIds={['u1', 'u2']} initiallyAllFollowing followedAllLabel="Following" />,
    );

    expect(screen.getByText('Following')).toBeTruthy();
    expect(screen.queryByText('Follow all')).toBeNull();
  });

  it('lets a known not-following store status override initiallyAllFollowing', () => {
    setFollowStatus('u1', false);
    setFollowStatus('u2', true);

    renderWithStore(
      <FollowButton userIds={['u1', 'u2']} initiallyAllFollowing followedAllLabel="Following" />,
    );

    expect(screen.getByText('Follow all')).toBeTruthy();
    expect(screen.queryByText('Following')).toBeNull();
  });
});
