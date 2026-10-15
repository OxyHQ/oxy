import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AccountInvitationAcceptance } from '../AccountInvitationAcceptance';
const mockPreview = jest.fn();
const mockAccept = jest.fn();
const mockSwitch = jest.fn();
let mockUser: { id: string; kind: string; email: string; username: string } | null = null;
const mockServices = { accounts: { invitations: { preview: mockPreview, accept: mockAccept } } };
jest.mock('../../context/OxyContext', () => ({
  useOxy: () => ({
    oxyServices: mockServices,
    user: mockUser,
    canUsePrivateApi: !!mockUser,
    openAccountDialog: mockSwitch,
  }),
}));
beforeEach(() => {
  jest.clearAllMocks();
  mockUser = null;
  mockPreview.mockResolvedValue({
    invitation: { role: 'editor' },
    account: { displayName: 'Community' },
  });
  mockAccept.mockResolvedValue({ success: true });
});
test('sign-in and switching never accept; confirmation names the displayed selected account', async () => {
  const { rerender } = render(<AccountInvitationAcceptance token="secret" />);
  fireEvent.click(screen.getByText('Sign in or create account'));
  expect(mockSwitch).toHaveBeenCalled();
  expect(mockAccept).not.toHaveBeenCalled();
  mockUser = { id: 'first', kind: 'personal', username: 'first', email: 'different@example.com' };
  rerender(<AccountInvitationAcceptance token="secret" />);
  await screen.findByText('Join Community as editor.');
  fireEvent.click(screen.getByText('Change account'));
  expect(mockAccept).not.toHaveBeenCalled();
  mockUser = { id: 'second', kind: 'personal', username: 'second', email: 'second@example.com' };
  rerender(<AccountInvitationAcceptance token="secret" />);
  expect(screen.getByText(/Selected account: second/)).toBeTruthy();
  fireEvent.click(screen.getByText('Confirm and accept'));
  await waitFor(() => expect(mockAccept).toHaveBeenCalledWith('secret', 'second'));
  await screen.findByText('Invitation accepted. You can now access this account.');
});
test('a new link resets previous acceptance and does not auto-accept', async () => {
  mockUser = { id: 'first', kind: 'personal', username: 'first', email: 'first@example.com' };
  const { rerender } = render(<AccountInvitationAcceptance token="old" />);
  await screen.findByText('Join Community as editor.');
  fireEvent.click(screen.getByText('Confirm and accept'));
  await screen.findByText('Invitation accepted. You can now access this account.');
  rerender(<AccountInvitationAcceptance token="new" />);
  await screen.findByText('Join Community as editor.');
  expect(screen.queryByText('Invitation accepted. You can now access this account.')).toBeNull();
  expect(mockAccept).toHaveBeenCalledTimes(1);
});
test('preview failure leaves confirmation disabled', async () => {
  mockUser = { id: 'first', kind: 'personal', username: 'first', email: 'first@example.com' };
  mockPreview.mockRejectedValue(new Error('Invitation expired'));
  render(<AccountInvitationAcceptance token="expired" />);
  await screen.findByText('Invitation expired');
  fireEvent.click(screen.getByText('Confirm and accept'));
  expect(mockAccept).not.toHaveBeenCalled();
});
