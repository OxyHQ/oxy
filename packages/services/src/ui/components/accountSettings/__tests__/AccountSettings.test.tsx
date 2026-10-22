import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AccountNode } from '@oxy.so/core';
import { AccountSettings } from '../AccountSettings';

const mockGet = jest.fn();
const mockUpdate = jest.fn();
const mockArchive = jest.fn();
const mockServices = {
  accounts: { get: mockGet, update: mockUpdate, archive: mockArchive },
  assets: { publicUrl: (id: string) => `https://cdn.test/${id}` },
};
jest.mock('../../../context/oxyRuntimeContext', () => ({
  useOptionalOxy: () => null,
  useOxy: () => ({
    oxyServices: mockServices,
    canUsePrivateApi: true,
    user: { id: 'viewer' },
    accounts: [],
    switchToAccount: jest.fn(),
    showBottomSheet: jest.fn(),
  }),
}));

function channel(permissions: string[]): AccountNode {
  return {
    accountId: 'chan',
    kind: 'channel',
    parentAccountId: null,
    relationship: 'member',
    callerMembership: { permissions } as AccountNode['callerMembership'],
    account: {
      id: 'chan',
      kind: 'channel',
      username: 'daily',
      name: { displayName: 'Daily' },
      bio: 'Every day',
      accountCategories: ['news', 'politics'],
    } as AccountNode['account'],
  };
}

function renderSettings(props: Partial<Parameters<typeof AccountSettings>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AccountSettings accountId="chan" {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => jest.clearAllMocks());

test('saves the profile with its categories in order and hands the write to the app', async () => {
  const node = channel(['account:update']);
  mockGet.mockResolvedValue(node);
  mockUpdate.mockResolvedValue(node);
  const onUpdated = jest.fn();
  renderSettings({ onUpdated, extraSections: <p>App section</p> });

  fireEvent.click(await screen.findByText('Make primary'));
  fireEvent.change(screen.getByLabelText('Bio (optional)'), { target: { value: '' } });
  fireEvent.click(screen.getByText('Save changes'));

  await waitFor(() =>
    expect(mockUpdate).toHaveBeenCalledWith('chan', {
      name: { displayName: 'Daily' },
      bio: null,
      accountCategories: ['politics', 'news'],
    }),
  );
  await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(node.account, { cleared: ['bio'] }));
  expect(screen.getByText('App section')).toBeTruthy();
  // Archiving is a separate right, and this member was not granted it.
  expect(screen.queryByText('Archive account')).toBeNull();
});

test("archiving runs the app's confirmation and pre-archive step before Oxy's archive", async () => {
  const order: string[] = [];
  mockGet.mockResolvedValue(channel(['account:delete']));
  mockArchive.mockImplementation(async () => order.push('archive'));
  const onArchived = jest.fn();
  renderSettings({
    archive: {
      title: 'Delete channel',
      confirm: async () => {
        order.push('confirm');
        return true;
      },
      beforeArchive: async () => {
        order.push('before');
      },
      onArchived,
    },
  });

  fireEvent.click(await screen.findByText('Delete channel'));

  await waitFor(() => expect(onArchived).toHaveBeenCalled());
  expect(order).toEqual(['confirm', 'before', 'archive']);
});
