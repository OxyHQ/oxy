import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createElement } from 'react';

const oxyServicesStub = {
  // Multi-user status resolution now goes through the batched bulk endpoint
  // (one call for all members) rather than N single `getFollowStatus` calls.
  getFollowStatuses: jest.fn(async (ids: string[]) =>
    Object.fromEntries(ids.map((id) => [id, false])),
  ),
  followUsers: jest.fn(),
  unfollowUsers: jest.fn(),
  getCurrentUserId: jest.fn(() => 'me'),
};

let ctx = {
  oxyServices: oxyServicesStub,
  canUsePrivateApi: true,
  user: { id: 'me' },
};

jest.mock('../../src/ui/context/OxyContext', () => ({
  useOxy: () => ctx,
}));

jest.mock('@oxy.so/core', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

import FollowButton from '../../src/ui/components/FollowButton';
import { useFollowStore } from '../../src/ui/stores/followStore';

const renderWithQueryClient = (children: ReactNode) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(createElement(QueryClientProvider, { client }, children));
};

describe('FollowButton multi-user initial state', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useFollowStore.getState().resetFollowState();
    ctx = { oxyServices: oxyServicesStub, canUsePrivateApi: true, user: { id: 'me' } };
  });

  it('does not render for an unauthenticated viewer or their own account', () => {
    ctx.canUsePrivateApi = false;
    const view = renderWithQueryClient(<FollowButton userId="u1" initiallyFollowing={false} />);
    expect(screen.queryByRole('button')).toBeNull();
    view.unmount();
    ctx.canUsePrivateApi = true;
    renderWithQueryClient(<FollowButton userId="me" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('keeps unknown status neutral and non-interactive until resolved', () => {
    renderWithQueryClient(<FollowButton userId="unresolved" />);
    const button = screen.getByRole('button', { name: 'Follow' });
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.textContent).toBe('');
  });

  it('does not announce an unaccepted single-user mutation as a follow', async () => {
    const toggle = jest.spyOn(useFollowStore.getState(), 'toggleFollowUser').mockResolvedValue(false);
    const onFollowChange = jest.fn();
    renderWithQueryClient(<FollowButton userId="u1" initiallyFollowing={false} onFollowChange={onFollowChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Follow' }));
    await waitFor(() => expect(toggle).toHaveBeenCalled());
    expect(onFollowChange).not.toHaveBeenCalled();
    toggle.mockRestore();
  });

  it('honors initiallyAllFollowing before async status fetch populates the store', () => {
    renderWithQueryClient(
      <FollowButton userIds={['u1', 'u2']} initiallyAllFollowing followedAllLabel="Following" />,
    );

    expect(screen.getByText('Following')).toBeTruthy();
    expect(screen.queryByText('Follow all')).toBeNull();
  });

  it('lets a known not-following store status override initiallyAllFollowing', () => {
    useFollowStore.getState().setFollowingStatus('u1', false);
    useFollowStore.getState().setFollowingStatus('u2', true);

    renderWithQueryClient(
      <FollowButton userIds={['u1', 'u2']} initiallyAllFollowing followedAllLabel="Following" />,
    );

    expect(screen.getByText('Follow all')).toBeTruthy();
    expect(screen.queryByText('Following')).toBeNull();
  });
});
